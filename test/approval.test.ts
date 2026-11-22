import { test, expect, describe } from "bun:test";
import { createApprover, isSafeCommand } from "../src/approval.ts";
import type { IO } from "../src/types.ts";

function fakeIO(answers: ("y" | "n" | "a")[] = []) {
  const asked: string[] = [];
  let paused = 0;
  const io: IO = {
    async confirm(q) {
      asked.push(q);
      return answers.shift() ?? "n";
    },
    async choose(_q, options) {
      return options[0] ?? "";
    },
    async prompt() {
      return null;
    },
    async secret() {
      return "";
    },
    async withPaused(fn) {
      paused++;
      return fn();
    },
    info() {},
  };
  return { io, asked, pausedCount: () => paused };
}

describe("isSafeCommand", () => {
  test("allowlisted read commands are safe", () => {
    for (const c of ["ls", "ls -la", "pwd", "cat README.md", "head -n 5 a.txt", "tail x", "wc -l a", "which node", "echo hi"]) {
      expect(isSafeCommand(c)).toBe(true);
    }
  });
  test("git read subcommands are safe", () => {
    for (const c of ["git status", "git log --oneline -5", "git diff", "git show HEAD"]) {
      expect(isSafeCommand(c)).toBe(true);
    }
  });
  test("first token must match exactly", () => {
    expect(isSafeCommand("catx")).toBe(false);
    expect(isSafeCommand("catastrophe")).toBe(false);
    expect(isSafeCommand("lsof")).toBe(false);
    expect(isSafeCommand("FOO=1 ls")).toBe(false);
    expect(isSafeCommand("rm -rf x")).toBe(false);
    expect(isSafeCommand("")).toBe(false);
  });
  test("other git subcommands are not safe", () => {
    expect(isSafeCommand("git push")).toBe(false);
    expect(isSafeCommand("git commit -m x")).toBe(false);
    expect(isSafeCommand("git")).toBe(false);
    expect(isSafeCommand("git -c core.pager=sh status")).toBe(false);
    expect(isSafeCommand("git diff --output=evil.sh")).toBe(false);
  });
  test("shell operators are rejected", () => {
    for (const c of [
      "git status && rm -rf x",
      "ls || rm -rf x",
      "ls; rm -rf x",
      "cat a | sh",
      "echo hi > a.txt",
      "cat < a.txt",
      "echo $(rm -rf x)",
      "echo `rm -rf x`",
      "ls\nrm -rf x",
      "ls & rm -rf x",
    ]) {
      expect(isSafeCommand(c)).toBe(false);
    }
  });
});

describe("approver", () => {
  const req = { tool: "bash", summary: "npm test", alwaysKey: "bash:npm test" };

  test("yolo allows without asking", async () => {
    const f = fakeIO();
    const a = createApprover(f.io, "yolo");
    expect(await a.request(req)).toBe("allow");
    expect(f.asked.length).toBe(0);
  });

  test("readonly refuses without asking", async () => {
    const f = fakeIO(["y"]);
    const a = createApprover(f.io, "readonly");
    expect(await a.request(req)).toBe("readonly");
    expect(await a.request({ tool: "edit", summary: "a.ts", alwaysKey: "edit" })).toBe("readonly");
    expect(f.asked.length).toBe(0);
  });

  test("ask mode prompts with the summary and maps y/n", async () => {
    const f = fakeIO(["y", "n"]);
    const a = createApprover(f.io, "ask");
    expect(await a.request(req)).toBe("allow");
    expect(await a.request(req)).toBe("deny");
    expect(f.asked[0]).toBe('Allow bash: npm test ? [y]es / [n]o / [a]lways for "npm test"');
    expect(f.pausedCount()).toBe(2);
  });

  test("detail is shown above the question", async () => {
    const f = fakeIO(["n"]);
    const a = createApprover(f.io, "ask");
    await a.request({ tool: "edit", summary: "src/a.ts (+1 −1)", detail: "- old\n+ new", alwaysKey: "edit" });
    expect(f.asked[0]).toStartWith("- old\n+ new\nAllow edit: src/a.ts (+1 −1) ?");
    expect(f.asked[0]).toContain("[a]lways for all edit calls this session");
  });

  test("always remembers the key for the session", async () => {
    const f = fakeIO(["a"]);
    const a = createApprover(f.io, "ask");
    expect(await a.request(req)).toBe("allow");
    expect(await a.request(req)).toBe("allow");
    expect(f.asked.length).toBe(1);
    // A different command still asks.
    expect(await a.request({ ...req, summary: "rm x", alwaysKey: "bash:rm x" })).toBe("deny");
    expect(f.asked.length).toBe(2);
  });

  test("setMode switches behavior", async () => {
    const f = fakeIO();
    const a = createApprover(f.io, "ask");
    a.setMode("yolo");
    expect(a.mode).toBe("yolo");
    expect(await a.request(req)).toBe("allow");
    a.setMode("readonly");
    expect(await a.request(req)).toBe("readonly");
  });
});
