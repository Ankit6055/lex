import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { cheapModelSpec, createTaskTool, TASK_MAX_CHARS, TASK_MAX_STEPS } from "../src/tools/task.ts";
import { buildTools, TOOL_NAMES } from "../src/tools/index.ts";
import type { ResolvedModel, ToolContext } from "../src/types.ts";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const finish = (unified: "stop" | "tool-calls") => ({ type: "finish" as const, usage, finishReason: { unified, raw: unified } });

/** One model step that calls a tool. */
const toolStep = (toolName: string, input: unknown, id = "c1") => ({
  stream: convertArrayToReadableStream<any>([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
    finish("tool-calls"),
  ]),
});
/** One model step that replies with text. */
const textStep = (text: string) => ({
  stream: convertArrayToReadableStream<any>([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    finish("stop"),
  ]),
});

const resolved = (model: MockLanguageModelV4, spec = "mock:m", provider = "mock"): ResolvedModel =>
  ({ spec, provider, id: "m", model }) as ResolvedModel;

let root: string;
let ctx: ToolContext;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "lex-task-")));
  await writeFile(path.join(root, "app.ts"), "export function hello() {\n  return 'hi';\n}\n");
  ctx = { root, memoryPath: path.join(root, ".lex", "memory.md") } as ToolContext;
});
afterEach(() => rm(root, { recursive: true, force: true }));

const exec = (tool: any, input: unknown, abortSignal?: AbortSignal) =>
  tool.execute(input, { toolCallId: "x", messages: [], abortSignal }) as Promise<string>;

describe("cheapModelSpec", () => {
  test("maps known providers to their cheap model", () => {
    expect(cheapModelSpec({ provider: "gateway", spec: "gateway:anthropic/claude-sonnet-5.5" })).toBe("gateway:anthropic/claude-haiku-5.5");
    expect(cheapModelSpec({ provider: "anthropic", spec: "anthropic:claude-opus-5-5" })).toBe("anthropic:claude-haiku-5-5");
    expect(cheapModelSpec({ provider: "openai", spec: "openai:gpt-6.2-sol" })).toBe("openai:gpt-6.1-terra");
  });
  test("reuses the parent model for other providers or when already cheap", () => {
    expect(cheapModelSpec({ provider: "groq", spec: "groq:openai/gpt-oss-120b" })).toBeUndefined();
    expect(cheapModelSpec({ provider: "gateway", spec: "gateway:anthropic/claude-haiku-5.5" })).toBeUndefined();
  });
});

describe("task tool", () => {
  test("runs a read-only explorer and returns its final text", async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolStep("grep", { pattern: "hello" }), textStep("hello is defined in app.ts:1")],
    });
    const task = createTaskTool(ctx, { getModel: () => resolved(model) });
    const out = await exec(task, { description: "Where is hello defined?" });
    expect(out).toBe("hello is defined in app.ts:1");

    // Only read-only tools are offered, with the explorer system prompt and the question.
    const call = model.doStreamCalls[0]!;
    expect((call.tools ?? []).map((t: any) => t.name).sort()).toEqual(["grep", "ls", "read"]);
    const prompt = JSON.stringify(call.prompt);
    expect(prompt).toContain("explorer");
    expect(prompt).toContain("Where is hello defined?");
    // The grep result came from the real tool, scoped to the project root.
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain("app.ts");
  });

  test("uses the cheap model for the parent's provider, resolved lazily and once", async () => {
    const parent = new MockLanguageModelV4({ doStream: [textStep("parent")] });
    const cheap = new MockLanguageModelV4({ doStream: [textStep("cheap 1"), textStep("cheap 2")] });
    const specs: string[] = [];
    const task = createTaskTool(ctx, {
      getModel: () => resolved(parent, "gateway:anthropic/claude-sonnet-5.5", "gateway"),
      resolve: async (spec) => { specs.push(spec); return resolved(cheap, spec, "gateway"); },
    });
    expect(specs).toEqual([]);
    expect(await exec(task, { description: "q1" })).toBe("cheap 1");
    expect(await exec(task, { description: "q2" })).toBe("cheap 2");
    expect(specs).toEqual(["gateway:anthropic/claude-haiku-5.5"]);
    expect(parent.doStreamCalls.length).toBe(0);
  });

  test("follows a mid-session model swap and falls back to the parent when resolution fails", async () => {
    const a = new MockLanguageModelV4({ doStream: [textStep("from a")] });
    const b = new MockLanguageModelV4({ doStream: [textStep("from b")] });
    let current = resolved(a, "anthropic:claude-opus-5-5", "anthropic");
    const task = createTaskTool(ctx, {
      getModel: () => current,
      resolve: async () => { throw new Error("no key"); },
    });
    expect(await exec(task, { description: "q" })).toBe("from a");
    current = resolved(b);
    expect(await exec(task, { description: "q" })).toBe("from b");
  });

  test("asks for a summary when the step budget runs out", async () => {
    const steps = Array.from({ length: TASK_MAX_STEPS }, (_, i) => toolStep("ls", {}, `c${i}`));
    const model = new MockLanguageModelV4({ doStream: [...steps, textStep("summary after budget")] });
    const task = createTaskTool(ctx, { getModel: () => resolved(model) });
    expect(await exec(task, { description: "explore" })).toBe("summary after budget");
    expect(model.doStreamCalls.length).toBe(TASK_MAX_STEPS + 1);
    // The wrap-up call gets the findings as plain text and no tools.
    const wrap = model.doStreamCalls[TASK_MAX_STEPS]!;
    expect(wrap.tools ?? []).toEqual([]);
    const prompt = JSON.stringify(wrap.prompt);
    expect(prompt).toContain("out of steps");
    expect(prompt).toContain("Findings so far");
    expect(prompt).toContain("Result of ls");
    expect(prompt).toContain("app.ts");
    expect(prompt).not.toContain("tool-call");
  });

  test("caps long summaries", async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep("y".repeat(TASK_MAX_CHARS + 1000))] });
    const out = await exec(createTaskTool(ctx, { getModel: () => resolved(model) }), { description: "q" });
    expect(out).toContain(`[truncated: showing first ${TASK_MAX_CHARS}`);
  });

  test("model errors become an Error string instead of throwing", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => { throw new Error("boom"); } });
    const quiet = spyOn(console, "error").mockImplementation(() => {}); // the AI SDK logs stream errors
    const out = await exec(createTaskTool(ctx, { getModel: () => resolved(model) }), { description: "q" }).finally(() => quiet.mockRestore());
    expect(out).toMatch(/^Error: explorer failed: .*boom/);
  });

  test("an aborted signal cancels the explorer", async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep("never")] });
    const ac = new AbortController();
    ac.abort();
    const out = await exec(createTaskTool(ctx, { getModel: () => resolved(model) }), { description: "q" }, ac.signal);
    expect(out).toBe("Error: task was cancelled.");
  });

  test("empty description is refused", async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep("never")] });
    expect(await exec(createTaskTool(ctx, { getModel: () => resolved(model) }), { description: "  " })).toMatch(/^Error: description is empty/);
  });
});

describe("buildTools", () => {
  test("offers TOOL_NAMES in order; task only with a model getter", () => {
    const model = new MockLanguageModelV4();
    expect(Object.keys(buildTools(ctx, { getModel: () => resolved(model) }))).toEqual([...TOOL_NAMES]);
    expect(Object.keys(buildTools(ctx))).toEqual(TOOL_NAMES.filter((n) => n !== "task"));
  });
});
