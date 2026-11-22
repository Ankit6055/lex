import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ApprovalRequest, ApprovalResult, Approver, IO, ToolContext } from "../src/types.ts";
import { createReadTool } from "../src/tools/read.ts";
import { createLsTool } from "../src/tools/ls.ts";
import { createGrepTool, makeGrepTool, hasRipgrep, globToRegExp } from "../src/tools/grep.ts";
import { createWriteTool } from "../src/tools/write.ts";
import { serialize } from "../src/util/serialize.ts";
import { createEditTool } from "../src/tools/edit.ts";

// ---- fakes ----

function fakeApprover(result: ApprovalResult): Approver & { requests: ApprovalRequest[] } {
  const requests: ApprovalRequest[] = [];
  return {
    mode: result === "readonly" ? "readonly" : "ask",
    requests,
    setMode() {},
    async request(req) {
      requests.push(req);
      return result;
    },
    isSafeCommand: () => false,
  };
}

const fakeIO: IO = {
  confirm: async () => "y",
  choose: async (_q, o) => o[0] ?? "",
  prompt: async () => null,
  secret: async () => "",
  withPaused: (fn) => fn(),
  info() {},
};

let root: string;
let outside: string;

function ctxWith(result: ApprovalResult = "allow"): ToolContext & { approver: ReturnType<typeof fakeApprover> } {
  return { root, approver: fakeApprover(result), io: fakeIO, memoryPath: path.join(root, ".lex/memory.md") };
}

async function run(t: unknown, input: Record<string, unknown>): Promise<string> {
  const out = await (t as any).execute(input, { toolCallId: "t", messages: [] });
  expect(typeof out).toBe("string");
  return out as string;
}

beforeEach(async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "lex-files-")));
  root = path.join(base, "proj");
  outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "top secret\n");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/a.ts"), "export const a = 1;\nexport function hello() {\n  return 'hi';\n}\n");
  await writeFile(path.join(root, "src/b.md"), "# hello world\n");
  await mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
  await writeFile(path.join(root, "node_modules/pkg/index.js"), "export function hello() {}\n");
});

afterEach(async () => {
  await rm(path.dirname(root), { recursive: true, force: true });
});

// ---- read ----

describe("read", () => {
  test("prefixes line numbers", async () => {
    const out = await run(createReadTool(ctxWith()), { path: "src/a.ts" });
    expect(out).toContain("1\texport const a = 1;");
    expect(out).toContain("4\t}");
    expect(out).not.toContain("truncated");
  });

  test("offset and limit", async () => {
    const out = await run(createReadTool(ctxWith()), { path: "src/a.ts", offset: 2, limit: 2 });
    expect(out.split("\n")[0]).toBe("2\texport function hello() {");
    expect(out).toContain("3\t  return 'hi';");
    expect(out).not.toContain("1\texport const");
    expect(out).toContain("Use offset=4");
  });

  test("caps at 500 lines with a use-offset hint", async () => {
    const big = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join("\n");
    await writeFile(path.join(root, "big.txt"), big);
    const out = await run(createReadTool(ctxWith()), { path: "big.txt" });
    expect(out).toContain("line 500");
    expect(out).not.toContain("line 501");
    expect(out).toContain("[truncated: showing lines 1-500 of 1200");
    expect(out).toContain("Use offset=501");
  });

  test("missing file returns an error string", async () => {
    expect(await run(createReadTool(ctxWith()), { path: "nope.ts" })).toBe("Error: file not found: nope.ts");
  });

  test("directory and offset past end return errors", async () => {
    expect(await run(createReadTool(ctxWith()), { path: "src" })).toContain("is a directory");
    expect(await run(createReadTool(ctxWith()), { path: "src/a.ts", offset: 99 })).toContain("past the end");
  });

  test("refuses binary files", async () => {
    await writeFile(path.join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    expect(await run(createReadTool(ctxWith()), { path: "bin.dat" })).toContain("binary");
  });
});

// ---- path escapes ----

describe("path escapes", () => {
  test("read, ls, grep, write and edit refuse paths outside the root", async () => {
    const ctx = ctxWith();
    await symlink(outside, path.join(root, "link"));
    const attempts = ["../outside/secret.txt", path.join(outside, "secret.txt"), "link/secret.txt"];
    for (const p of attempts) {
      expect(await run(createReadTool(ctx), { path: p })).toContain("outside the project root");
      expect(await run(createWriteTool(ctx), { path: p, content: "pwned" })).toContain("outside the project root");
      expect(await run(createEditTool(ctx), { path: p, old_string: "top", new_string: "pwned" })).toContain(
        "outside the project root",
      );
    }
    expect(await run(createLsTool(ctx), { path: ".." })).toContain("outside the project root");
    expect(await run(createLsTool(ctx), { pattern: "../*" })).toContain('must not contain ".."');
    expect(await run(createGrepTool(ctx), { pattern: "secret", path: "../outside" })).toContain("outside the project root");
    expect(await run(makeGrepTool(ctx, { engine: "js" }), { pattern: "secret", path: "link" })).toContain(
      "outside the project root",
    );
    expect(ctx.approver.requests).toHaveLength(0); // refused before asking
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("top secret\n");
  });
});

// ---- ls ----

describe("ls", () => {
  test("default lists the directory, dirs end with / and node_modules is skipped", async () => {
    const out = await run(createLsTool(ctxWith()), {});
    expect(out.split("\n")).toEqual(["src/"]);
  });

  test("path and recursive pattern", async () => {
    const out = await run(createLsTool(ctxWith()), { path: "src", pattern: "**/*.ts" });
    expect(out).toBe("src/a.ts");
    const all = await run(createLsTool(ctxWith()), { pattern: "**/*" });
    expect(all).not.toContain("node_modules");
    expect(all).toContain("src/b.md");
  });

  test("caps at 200 entries with a notice", async () => {
    await mkdir(path.join(root, "many"));
    for (let i = 0; i < 250; i++) await writeFile(path.join(root, "many", `f${String(i).padStart(3, "0")}.txt`), "");
    const out = await run(createLsTool(ctxWith()), { path: "many" });
    const lines = out.split("\n");
    expect(lines).toHaveLength(201);
    expect(lines[0]).toBe("many/f000.txt");
    expect(out).toContain("[truncated: showing 200 of 250 entries");
  });

  test("errors are strings", async () => {
    expect(await run(createLsTool(ctxWith()), { path: "missing" })).toBe("Error: file not found: missing");
    expect(await run(createLsTool(ctxWith()), { path: "src/a.ts" })).toContain("not a directory");
  });
});

// ---- grep ----

const engines: ("js" | "rg")[] = ["js"];
if (await hasRipgrep()) engines.push("rg");

describe.each(engines)("grep (%s engine)", (engine) => {
  const grep = (ctx: ToolContext) => makeGrepTool(ctx, { engine });

  test("finds matches as path:line: text, skipping node_modules", async () => {
    const out = await run(grep(ctxWith()), { pattern: "hel+o" });
    expect(out).toContain("src/a.ts:2: export function hello() {");
    expect(out).toContain("src/b.md:1: # hello world");
    expect(out).not.toContain("node_modules");
    expect(out).toContain("(2 matches)");
  });

  test("path and glob filters", async () => {
    expect(await run(grep(ctxWith()), { pattern: "hello", glob: "*.md" })).toContain("src/b.md:1:");
    expect(await run(grep(ctxWith()), { pattern: "hello", glob: "*.md" })).not.toContain("a.ts");
    expect(await run(grep(ctxWith()), { pattern: "hello", path: "src/a.ts" })).toContain("src/a.ts:2:");
  });

  test("no matches", async () => {
    expect(await run(grep(ctxWith()), { pattern: "zzz_nothing" })).toContain("No matches");
  });

  test("caps at 50 matches with the total count, and caps long lines", async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `needle ${i}`);
    lines.push(`needle ${"x".repeat(2000)}`);
    await writeFile(path.join(root, "hay.txt"), lines.join("\n"));
    const out = await run(grep(ctxWith()), { pattern: "needle", path: "hay.txt" });
    const body = out.split("\n");
    expect(body).toHaveLength(51);
    expect(out).toContain("[truncated: showing 50 of 121 matches");

    const long = await run(grep(ctxWith()), { pattern: "needle x", path: "hay.txt" });
    expect(long).toContain("[line truncated: 2007 chars]");
    expect(long.split("\n")[0]!.length).toBeLessThan(600);
  });

  test("invalid regex returns an error string", async () => {
    expect(await run(grep(ctxWith()), { pattern: "(unclosed" })).toStartWith("Error:");
  });
});

test("grep auto engine works whichever engine is present", async () => {
  expect(await run(createGrepTool(ctxWith()), { pattern: "hello" })).toContain("src/a.ts:2:");
});

test("globToRegExp", () => {
  expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
  expect(globToRegExp("*.ts").test("a/b.ts")).toBe(false);
  expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
  expect(globToRegExp("src/**/*.ts").test("src/x/y/a.ts")).toBe(true);
  expect(globToRegExp("*.{ts,md}").test("b.md")).toBe(true);
});

// ---- write ----

describe("write", () => {
  test("asks first, creates parent dirs, reports line count", async () => {
    const ctx = ctxWith("allow");
    const out = await run(createWriteTool(ctx), { path: "deep/new/file.txt", content: "a\nb\nc\n" });
    expect(out).toBe("Created deep/new/file.txt (3 lines).");
    expect(await readFile(path.join(root, "deep/new/file.txt"), "utf8")).toBe("a\nb\nc\n");
    expect(ctx.approver.requests).toHaveLength(1);
    expect(ctx.approver.requests[0]!.tool).toBe("write");
    expect(ctx.approver.requests[0]!.alwaysKey).toBe("write");
    expect(ctx.approver.requests[0]!.summary).toBe("deep/new/file.txt (new file, 3 lines)");
  });

  test("overwrite is labeled", async () => {
    const ctx = ctxWith("allow");
    expect(await run(createWriteTool(ctx), { path: "src/b.md", content: "x" })).toBe("Overwrote src/b.md (1 line).");
    expect(ctx.approver.requests[0]!.summary).toContain("overwrite");
  });

  test("deny leaves the file unchanged", async () => {
    const ctx = ctxWith("deny");
    const out = await run(createWriteTool(ctx), { path: "src/a.ts", content: "gone" });
    expect(out).toBe("User denied this action. Ask them how to proceed.");
    expect(await readFile(path.join(root, "src/a.ts"), "utf8")).toContain("export const a = 1;");
    expect(await run(createWriteTool(ctx), { path: "new.txt", content: "x" })).toContain("denied");
    expect(await Bun.file(path.join(root, "new.txt")).exists()).toBe(false);
  });

  test("readonly leaves the file unchanged and says so", async () => {
    const ctx = ctxWith("readonly");
    const out = await run(createWriteTool(ctx), { path: "src/a.ts", content: "gone" });
    expect(out).toContain("read-only");
    expect(out).toContain("src/a.ts was not changed");
    expect(await readFile(path.join(root, "src/a.ts"), "utf8")).toContain("export const a = 1;");
  });
});

// ---- edit ----

describe("edit", () => {
  const file = () => path.join(root, "e.txt");
  beforeEach(async () => {
    await writeFile(file(), "alpha\nbeta\ngamma\nbeta\n");
  });

  test("single replace with diff and summary", async () => {
    const ctx = ctxWith("allow");
    const out = await run(createEditTool(ctx), { path: "e.txt", old_string: "alpha", new_string: "ALPHA\nextra" });
    expect(out).toBe("Edited e.txt: replaced 1 occurrence (+2 −1).");
    expect(await readFile(file(), "utf8")).toBe("ALPHA\nextra\nbeta\ngamma\nbeta\n");
    const req = ctx.approver.requests[0]!;
    expect(req.tool).toBe("edit");
    expect(req.alwaysKey).toBe("edit");
    expect(req.summary).toBe("e.txt (+2 −1)");
    expect(req.detail).toContain("- alpha");
    expect(req.detail).toContain("+ ALPHA");
  });

  test("0 matches fails with an explanation and asks nothing", async () => {
    const ctx = ctxWith("allow");
    const out = await run(createEditTool(ctx), { path: "e.txt", old_string: "delta", new_string: "x" });
    expect(out).toContain("not found");
    expect(ctx.approver.requests).toHaveLength(0);
    expect(await readFile(file(), "utf8")).toBe("alpha\nbeta\ngamma\nbeta\n");
  });

  test(">1 match without replace_all fails and says how many", async () => {
    const out = await run(createEditTool(ctxWith()), { path: "e.txt", old_string: "beta", new_string: "x" });
    expect(out).toContain("matches 2 times");
    expect(out).toContain("replace_all");
    expect(await readFile(file(), "utf8")).toBe("alpha\nbeta\ngamma\nbeta\n");
  });

  test("replace_all replaces every occurrence", async () => {
    const ctx = ctxWith();
    const out = await run(createEditTool(ctx), { path: "e.txt", old_string: "beta", new_string: "BETA", replace_all: true });
    expect(out).toBe("Edited e.txt: replaced 2 occurrences (+2 −2).");
    expect(await readFile(file(), "utf8")).toBe("alpha\nBETA\ngamma\nBETA\n");
    expect(ctx.approver.requests[0]!.summary).toBe("e.txt (+2 −2), 2 replacements");
  });

  test("replacement text with $ patterns is literal", async () => {
    await run(createEditTool(ctxWith()), { path: "e.txt", old_string: "gamma", new_string: "$& $1 $$" });
    expect(await readFile(file(), "utf8")).toBe("alpha\nbeta\n$& $1 $$\nbeta\n");
  });

  test("deny and readonly leave the file unchanged", async () => {
    const deny = await run(createEditTool(ctxWith("deny")), { path: "e.txt", old_string: "alpha", new_string: "x" });
    expect(deny).toBe("User denied this action. Ask them how to proceed.");
    const ro = await run(createEditTool(ctxWith("readonly")), { path: "e.txt", old_string: "alpha", new_string: "x" });
    expect(ro).toContain("read-only");
    expect(await readFile(file(), "utf8")).toBe("alpha\nbeta\ngamma\nbeta\n");
  });

  test("missing file and empty old_string are errors", async () => {
    expect(await run(createEditTool(ctxWith()), { path: "nope.txt", old_string: "a", new_string: "b" })).toBe(
      "Error: file not found: nope.txt",
    );
    expect(await run(createEditTool(ctxWith()), { path: "e.txt", old_string: "", new_string: "b" })).toStartWith("Error:");
  });

  test("concurrent edits are serialized and none are lost", async () => {
    await writeFile(file(), "a b c d e f g h\n");
    const ctx = ctxWith();
    const letters = "abcdefgh".split("");
    const outs = await Promise.all(
      letters.map((l) => run(createEditTool(ctx), { path: "e.txt", old_string: `${l}`, new_string: l.toUpperCase() })),
    );
    for (const o of outs) expect(o).toStartWith("Edited");
    expect(await readFile(file(), "utf8")).toBe("A B C D E F G H\n");
  });
});

test("serialize runs tasks one at a time and survives failures", async () => {
  const order: string[] = [];
  const slow = serialize(async () => {
    await new Promise((r) => setTimeout(r, 20));
    order.push("slow");
  });
  const failing = serialize(async () => {
    order.push("fail");
    throw new Error("boom");
  });
  const fast = serialize(async () => {
    order.push("fast");
  });
  await slow;
  await expect(failing).rejects.toThrow("boom");
  await fast;
  expect(order).toEqual(["slow", "fail", "fast"]);
});
