import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgent, runTurn, type Chunk } from "../src/agent.ts";
import { createApprover } from "../src/approval.ts";
import { buildTools } from "../src/tools/index.ts";
import type { ApprovalMode, IO, ResolvedModel } from "../src/types.ts";

type ModelStream = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"];
type StreamPart = ModelStream extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function step(unified: "stop" | "tool-calls", ...parts: StreamPart[]) {
  return {
    stream: convertArrayToReadableStream<StreamPart>([
      { type: "stream-start", warnings: [] },
      ...parts,
      { type: "finish", finishReason: { unified, raw: unified }, usage },
    ]),
  };
}

function toolCall(toolCallId: string, toolName: string, input: Record<string, unknown>): StreamPart {
  return { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) };
}

function reply(...deltas: string[]) {
  return step("stop",
    { type: "text-start", id: "reply" },
    ...deltas.map((delta) => ({ type: "text-delta" as const, id: "reply", delta })),
    { type: "text-end", id: "reply" },
  );
}

describe("agent and project tools", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "lex-agent-")));
    await writeFile(path.join(root, "note.txt"), "before\n");
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  function setup(model: MockLanguageModelV4, mode: ApprovalMode = "ask", maxSteps?: number) {
    const approvals: string[] = [];
    const io: IO = {
      async confirm(question) {
        approvals.push(question);
        // Give a concurrently started read time to observe the file before approval.
        await Bun.sleep(25);
        return "y";
      },
      async choose() { throw new Error("Unexpected choice prompt"); },
      async prompt() { throw new Error("Unexpected input prompt"); },
      async secret() { throw new Error("Unexpected secret prompt"); },
      withPaused: (fn) => fn(),
      info() {},
    };
    const resolved: ResolvedModel = { spec: "mock:agent", id: "agent", provider: "mock", model };
    const tools = buildTools({ root, io, approver: createApprover(io, mode), memoryPath: path.join(root, ".lex", "memory.md") });
    const agent = createAgent({ model: resolved, tools, instructions: "Use project tools to answer the request.", maxSteps });
    const chunks: Chunk[] = [];
    const turn = (input: string, signal?: AbortSignal) =>
      runTurn(agent, [{ role: "user", content: input }], {
        signal,
        onChunk: (chunk) => chunks.push(chunk),
      });
    return { turn, approvals, chunks };
  }

  test("runs same-step writes and reads in order, then streams the final text", async () => {
    const model = new MockLanguageModelV4({ doStream: [
      step("tool-calls",
        toolCall("write-note", "write", { path: "note.txt", content: "after\n" }),
        toolCall("read-note", "read", { path: "note.txt" }),
      ),
      reply("The note now says ", "after."),
    ] });
    const { turn, approvals, chunks } = setup(model);

    const result = await turn("Update the note to say after, then confirm its contents.");

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toContain("note.txt");
    expect(await readFile(path.join(root, "note.txt"), "utf8")).toBe("after\n");
    expect(model.doStreamCalls).toHaveLength(2);
    const followUpToolMessages = model.doStreamCalls[1]!.prompt.filter((message) => message.role === "tool");
    expect(followUpToolMessages.flatMap((message) => message.content)).toMatchObject([
      { type: "tool-result", toolCallId: "write-note", output: { type: "text", value: "Overwrote note.txt (1 line)." } },
      { type: "tool-result", toolCallId: "read-note", output: { type: "text", value: "1\tafter" } },
    ]);
    expect(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text)).toEqual([
      "The note now says ", "after.",
    ]);
    expect(result).toMatchObject({
      text: "The note now says after.", aborted: false,
      usage: { steps: 2, toolCalls: 2, inputTokens: 20, outputTokens: 10 },
    });
    expect(result.responseMessages.map((message) => message.role)).toEqual(["assistant", "tool", "assistant"]);
  });

  test("feeds a read-only write refusal back to the model without prompting or changing the file", async () => {
    const model = new MockLanguageModelV4({ doStream: [
      step("tool-calls", toolCall("write-note", "write", { path: "note.txt", content: "after\n" })),
      reply("I can suggest the edit."),
    ] });
    const { turn, approvals } = setup(model, "readonly");

    const result = await turn("Update the note.");

    expect(result.text).toBe("I can suggest the edit.");
    expect(approvals).toEqual([]);
    expect(await readFile(path.join(root, "note.txt"), "utf8")).toBe("before\n");
    const toolResponse = model.doStreamCalls[1]!.prompt.find((message) => message.role === "tool");
    expect(toolResponse?.content).toMatchObject([
      { toolCallId: "write-note", output: { type: "text", value: expect.stringContaining("note.txt was not changed") } },
    ]);
  });

  test("keeps the completed tool output when the step budget ends the loop", async () => {
    const model = new MockLanguageModelV4({ doStream: [
      step("tool-calls", toolCall("read-note", "read", { path: "note.txt" })),
      reply("This step exceeds the budget."),
    ] });
    const { turn } = setup(model, "readonly", 1);

    const result = await turn("Read the note.");

    expect(model.doStreamCalls).toHaveLength(1);
    expect(result).toMatchObject({ text: "", aborted: false, usage: { steps: 1, toolCalls: 1 } });
    expect(result.responseMessages.find((message) => message.role === "tool")?.content).toMatchObject([
      { toolCallId: "read-note", output: { type: "text", value: "1\tbefore" } },
    ]);
  });

  test("reports a pre-cancelled turn without contacting the model or executing tools", async () => {
    const model = new MockLanguageModelV4({ doStream: [
      step("tool-calls", toolCall("write-note", "write", { path: "note.txt", content: "after\n" })),
    ] });
    const { turn, approvals } = setup(model);

    const result = await turn("Update the note.", AbortSignal.abort());

    expect(model.doStreamCalls).toEqual([]);
    expect(approvals).toEqual([]);
    expect(await readFile(path.join(root, "note.txt"), "utf8")).toBe("before\n");
    expect(result).toMatchObject({ text: "", responseMessages: [], aborted: true, usage: { steps: 0, toolCalls: 0 } });
  });
});
