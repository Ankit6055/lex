import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, realpath, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Tool } from "ai";
import { createApprover } from "../src/approval.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { DENIED_MESSAGE as DENIED } from "../src/approval.ts";
import { createTodoTool, getTodoList } from "../src/tools/todo.ts";
import { createAskUserTool } from "../src/tools/ask.ts";
import { createRememberTool } from "../src/tools/remember.ts";
import type { ApprovalMode, IO, ToolContext } from "../src/types.ts";

function fakeIO(opts: { confirm?: ("y" | "n" | "a")[]; choose?: string } = {}) {
  const confirms = [...(opts.confirm ?? [])];
  const log: string[] = [];
  const io: IO = {
    async confirm(q) {
      log.push(`confirm:${q}`);
      return confirms.shift() ?? "n";
    },
    async choose(q, options) {
      log.push(`choose:${q}:${options.join("|")}`);
      return opts.choose ?? options[0] ?? "";
    },
    async prompt() {
      return null;
    },
    async secret() {
      return "";
    },
    async withPaused(fn) {
      log.push("paused");
      return fn();
    },
    info(m) {
      log.push(`info:${m}`);
    },
  };
  return { io, log };
}

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "lex-1c-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeCtx(mode: ApprovalMode, io: IO): ToolContext {
  return { root, io, approver: createApprover(io, mode), memoryPath: path.join(root, ".lex", "memory.md") };
}

const call = (t: Tool, input: unknown): Promise<string> =>
  (t as any).execute(input, { toolCallId: "t", messages: [] });

describe("bash", () => {
  test("safe command runs without approval and returns exit code", async () => {
    const f = fakeIO();
    await writeFile(path.join(root, "hello.txt"), "hi there\n");
    const out = await call(createBashTool(makeCtx("ask", f.io)), { command: "cat hello.txt" });
    expect(out).toBe("exit 0\nhi there\n");
    expect(f.log.filter((l) => l.startsWith("confirm")).length).toBe(0);
  });

  test("chained command needs approval; denial returns the denial message", async () => {
    const f = fakeIO({ confirm: ["n"] });
    await writeFile(path.join(root, "x"), "keep");
    const out = await call(createBashTool(makeCtx("ask", f.io)), { command: "git status && rm -rf x" });
    expect(out).toBe(DENIED);
    expect(f.log).toContain('confirm:Allow bash: git status && rm -rf x ? [y]es / [n]o / [a]lways for "git status && rm -rf x"');
    expect(await readFile(path.join(root, "x"), "utf8")).toBe("keep");
  });

  test("captures stderr and non-zero exit codes in order", async () => {
    const f = fakeIO({ confirm: ["y"] });
    const out = await call(createBashTool(makeCtx("ask", f.io)), {
      command: "echo out1; sleep 0.05; echo err1 1>&2; sleep 0.05; echo out2; exit 3",
    });
    expect(out).toBe("exit 3\nout1\nerr1\nout2\n");
  });

  test("runs in the project root", async () => {
    const f = fakeIO();
    const out = await call(createBashTool(makeCtx("ask", f.io)), { command: "pwd" });
    expect(out).toBe(`exit 0\n${root}\n`);
  });

  test("timeout kills the command", async () => {
    const f = fakeIO();
    const t0 = Date.now();
    const out = await call(createBashTool(makeCtx("yolo", f.io)), { command: "sleep 5", timeout_ms: 200 });
    expect(out.startsWith("timed out after 200ms")).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("abort signal stops the command", async () => {
    const f = fakeIO();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const out: string = await (createBashTool(makeCtx("yolo", f.io)) as any).execute(
      { command: "sleep 5" },
      { toolCallId: "t", messages: [], abortSignal: ac.signal },
    );
    expect(out).toStartWith("aborted");
  });

  test("output is capped to the last 5000 chars", async () => {
    const f = fakeIO();
    const out = await call(createBashTool(makeCtx("yolo", f.io)), {
      command: "for i in $(seq 1 3000); do echo line$i; done",
    });
    expect(out).toContain("[truncated: showing last 5000 of");
    expect(out.trimEnd().endsWith("line3000")).toBe(true);
  });

  test("readonly refuses unsafe commands but runs safe ones", async () => {
    const f = fakeIO({ confirm: ["y"] });
    const tool = createBashTool(makeCtx("readonly", f.io));
    const refused = await call(tool, { command: "touch made.txt" });
    expect(refused).toContain("read-only");
    expect(await Bun.file(path.join(root, "made.txt")).exists()).toBe(false);
    expect(await call(tool, { command: "echo ok" })).toBe("exit 0\nok\n");
    expect(f.log.filter((l) => l.startsWith("confirm")).length).toBe(0);
  });

  test("yolo runs unsafe commands without asking", async () => {
    const f = fakeIO();
    const out = await call(createBashTool(makeCtx("yolo", f.io)), { command: "touch made.txt && echo done" });
    expect(out).toBe("exit 0\ndone\n");
    expect(f.log.filter((l) => l.startsWith("confirm")).length).toBe(0);
  });

  test("always remembers the exact command", async () => {
    const f = fakeIO({ confirm: ["a"] });
    const tool = createBashTool(makeCtx("ask", f.io));
    expect(await call(tool, { command: "echo a | cat" })).toBe("exit 0\na\n");
    expect(await call(tool, { command: "echo a | cat" })).toBe("exit 0\na\n");
    expect(f.log.filter((l) => l.startsWith("confirm")).length).toBe(1);
  });
});

describe("todo", () => {
  test("add/start/complete render a checklist", async () => {
    const tool = createTodoTool(makeCtx("ask", fakeIO().io));
    await call(tool, { action: "add", description: "write code" });
    const out = await call(tool, { action: "add", description: "write tests" });
    expect(out).toContain("[ ] #1 write code");
    expect(out).toContain("[ ] #2 write tests");
    expect(await call(tool, { action: "start", id: 1 })).toContain("[~] #1 write code");
    const done = await call(tool, { action: "complete", id: 1 });
    expect(done).toContain("[x] #1 write code");
    expect(done).toContain("Todos (1/2 done)");
    expect(getTodoList(tool).map((i) => i.status)).toEqual(["completed", "pending"]);
  });

  test("only one item can be in progress", async () => {
    const tool = createTodoTool(makeCtx("ask", fakeIO().io));
    await call(tool, { action: "add", description: "a" });
    await call(tool, { action: "add", description: "b" });
    await call(tool, { action: "start", id: 1 });
    const out = await call(tool, { action: "start", id: 2 });
    expect(out).toStartWith("Error: #1");
    expect(out).toContain("Only one item can be in progress");
    expect(getTodoList(tool).filter((i) => i.status === "in_progress").length).toBe(1);
    await call(tool, { action: "complete", id: 1 });
    expect(await call(tool, { action: "start", id: 2 })).toContain("[~] #2 b");
  });

  test("bad input returns errors instead of throwing", async () => {
    const tool = createTodoTool(makeCtx("ask", fakeIO().io));
    expect(await call(tool, { action: "add" })).toStartWith("Error:");
    expect(await call(tool, { action: "start", id: 99 })).toStartWith("Error:");
    expect(await call(tool, { action: "list" })).toBe("(no todos yet)");
  });

  test("each tool instance has its own list", async () => {
    const a = createTodoTool(makeCtx("ask", fakeIO().io));
    const b = createTodoTool(makeCtx("ask", fakeIO().io));
    await call(a, { action: "add", description: "only in a" });
    expect(getTodoList(a).length).toBe(1);
    expect(getTodoList(b).length).toBe(0);
  });
});

describe("ask_user", () => {
  test("blocks on io.choose inside withPaused and returns the answer", async () => {
    const f = fakeIO({ choose: "vitest" });
    const out = await call(createAskUserTool(makeCtx("ask", f.io)), {
      question: "Which runner?",
      options: ["bun test", "vitest"],
    });
    expect(out).toBe("vitest");
    expect(f.log).toEqual(["paused", "choose:Which runner?:bun test|vitest"]);
  });
});

describe("remember", () => {
  test("appends dated bullets, creating .lex/", async () => {
    const ctx = makeCtx("ask", fakeIO().io);
    const tool = createRememberTool(ctx);
    expect(await call(tool, { fact: "Use bun test" })).toContain("Remembered");
    await call(tool, { fact: "Prefers\nsmall commits" });
    const text = await readFile(ctx.memoryPath, "utf8");
    const date = /^- \(\d{4}-\d{2}-\d{2}\) /;
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(date);
    expect(lines[0]).toEndWith("Use bun test");
    expect(lines[1]).toEndWith("Prefers small commits");
  });

  test("keeps the file at 4000 chars by dropping the oldest bullets", async () => {
    const ctx = makeCtx("ask", fakeIO().io);
    await mkdir(path.dirname(ctx.memoryPath), { recursive: true });
    const old = Array.from({ length: 60 }, (_, i) => `- (2020-01-01) old fact ${i} ${"x".repeat(60)}`).join("\n");
    await writeFile(ctx.memoryPath, `# Memory\n${old}\n`);
    const out = await call(createRememberTool(ctx), { fact: "newest fact" });
    expect(out).toContain("Dropped");
    const text = await readFile(ctx.memoryPath, "utf8");
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toStartWith("# Memory\n");
    expect(text).not.toContain("old fact 0 ");
    expect(text).toContain("old fact 59 ");
    expect(text.trimEnd()).toEndWith("newest fact");
  });
});

describe("io (no TTY)", () => {
  test("confirm denies, choose refuses to guess, prompt reads piped lines then null", async () => {
    const script = `
      import { createIO } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/io.ts"))};
      const io = createIO();
      const c = await io.withPaused(() => io.confirm("Allow bash: x ?"));
      const ch = await io.choose("Pick", ["a", "b"]).then(() => "answered", () => "threw");
      const p1 = await io.prompt("> ");
      const p2 = await io.prompt("> ");
      const p3 = await io.prompt("> ");
      console.log(JSON.stringify({ c, ch, p1, p2, p3 }));
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdin: new Blob(["hello\nworld\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 5000);
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    clearTimeout(timer);
    expect(JSON.parse(stdout.trim())).toEqual({ c: "n", ch: "threw", p1: "hello", p2: "world", p3: null });
    expect(stderr).toContain("no interactive terminal");
  });
});
