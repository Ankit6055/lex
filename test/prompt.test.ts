import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSystemPrompt } from "../src/prompt.ts";
import { loadContext } from "../src/context.ts";
import type { PromptContext } from "../src/types.ts";

// Mirrors TOOL_NAMES in src/tools/index.ts; kept local so this test doesn't import the tool factories.
const ALL_TOOLS = ["read", "ls", "grep", "write", "edit", "bash", "todo", "ask_user", "remember"];

const base: PromptContext = { cwd: "/work/app", os: "macOS 25.0", date: "2026-11-22", toolNames: ALL_TOOLS };

describe("buildSystemPrompt", () => {
  test("minimal context: identity, rules, env; no optional sections", () => {
    const p = buildSystemPrompt(base);
    expect(p.startsWith("You are lex, a coding agent.")).toBe(true);
    expect(p).toContain("<env>\ncwd: /work/app\nos: macOS 25.0\ndate: 2026-11-22\n</env>");
    expect(p).not.toContain("git branch");
    for (const tag of ["<project_instructions", "<memory>", "<skills>"]) expect(p).not.toContain(tag);
  });

  test("stays small: the full-context prompt is under 1,600 chars before user content", () => {
    expect(buildSystemPrompt({ ...base, toolNames: [...ALL_TOOLS, "task", "load_skill"], gitBranch: "main" }).length).toBeLessThan(1600);
  });

  test("sections appear in order: identity, rules, env, instructions, memory, skills", () => {
    const p = buildSystemPrompt({
      ...base,
      gitBranch: "main",
      projectInstructions: { file: "/work/app/AGENTS.md", content: "Use pnpm." },
      memory: "- (2026-11-01) tests: bun test",
      skills: [{ name: "deploy", description: "Ship to prod" }],
    });
    const order = ["You are lex", "- Read a file before editing", "<env>", "<project_instructions", "<memory>", "<skills>"];
    const idx = order.map((h) => p.indexOf(h));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  test("branch line only when present", () => {
    expect(buildSystemPrompt({ ...base, gitBranch: "feat/x" })).toContain("git branch: feat/x");
    expect(buildSystemPrompt(base)).not.toContain("git branch");
  });

  test("project instructions show the file (relative to cwd) and content", () => {
    const p = buildSystemPrompt({ ...base, projectInstructions: { file: "/work/CLAUDE.md", content: "Always use tabs." } });
    expect(p).toContain('<project_instructions path="../CLAUDE.md">\nAlways use tabs.\n</project_instructions>');
  });

  test("memory contents only when present; remember rule whenever the tool exists", () => {
    const withMem = buildSystemPrompt({ ...base, memory: "- (2026-11-01) run `make check`" });
    expect(withMem).toContain("<memory>\n- (2026-11-01) run `make check`\n</memory>");
    expect(withMem).toContain("with remember");
    const noMem = buildSystemPrompt(base);
    expect(noMem).not.toContain("<memory>");
    expect(noMem).toContain("with remember");
    const noToolWithMem = buildSystemPrompt({ ...base, toolNames: ["read"], memory: "fact A" });
    expect(noToolWithMem).toContain("fact A");
    expect(noToolWithMem).not.toContain("remember");
  });

  test("skills: one line each, omitted when empty", () => {
    const p = buildSystemPrompt({
      ...base,
      toolNames: [...ALL_TOOLS, "load_skill"],
      skills: [
        { name: "deploy", description: "Ship to prod" },
        { name: "review", description: "Review a diff" },
      ],
    });
    expect(p).toContain("<skills>\n- deploy: Ship to prod\n- review: Review a diff\n</skills>\nLoad a skill with load_skill");
    expect(buildSystemPrompt({ ...base, skills: [] })).not.toContain("<skills>");
  });

  test("tool-specific rules only when the tool is available", () => {
    const p = buildSystemPrompt({ ...base, toolNames: ["read", "grep", "ls"] });
    for (const name of ["todo", "ask_user", "bash", "task", "remember"]) expect(p).not.toContain(name);
    const full = buildSystemPrompt({ ...base, toolNames: [...ALL_TOOLS, "task"] });
    for (const name of ["todo", "ask_user", "bash", "task", "remember"]) expect(full).toContain(name);
  });

  test("is pure", () => {
    expect(buildSystemPrompt(base)).toBe(buildSystemPrompt({ ...base }));
  });
});

describe("loadContext", () => {
  let tmp: string;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(path.join(tmpdir(), "lex-ctx-")));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function gitRepo(): Promise<{ repo: string; sub: string }> {
    const repo = path.join(tmp, "repo");
    const sub = path.join(repo, "pkg");
    await mkdir(sub, { recursive: true });
    git(repo, "init", "-q", "-b", "trunk");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    return { repo, sub };
  }

  test("basic fields", async () => {
    const ctx = await loadContext(tmp);
    expect(ctx.cwd).toBe(tmp);
    expect(ctx.os.length).toBeGreaterThan(0);
    expect(ctx.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("finds CLAUDE.md one directory up in a git repo, and reads the branch", async () => {
    const { repo, sub } = await gitRepo();
    await writeFile(path.join(repo, "CLAUDE.md"), "root rules");
    const ctx = await loadContext(sub);
    expect(ctx.gitBranch).toBe("trunk");
    expect(ctx.projectInstructions).toEqual({ file: path.join(repo, "CLAUDE.md"), content: "root rules" });
  });

  test("AGENTS.md is preferred over CLAUDE.md in the same directory", async () => {
    const { repo } = await gitRepo();
    await writeFile(path.join(repo, "CLAUDE.md"), "claude");
    await writeFile(path.join(repo, "AGENTS.md"), "agents");
    const ctx = await loadContext(repo);
    expect(ctx.projectInstructions?.file).toBe(path.join(repo, "AGENTS.md"));
    expect(ctx.projectInstructions?.content).toBe("agents");
  });

  test("nearest directory wins", async () => {
    const { repo, sub } = await gitRepo();
    await writeFile(path.join(repo, "AGENTS.md"), "outer");
    await writeFile(path.join(sub, "LEX.md"), "inner");
    const ctx = await loadContext(sub);
    expect(ctx.projectInstructions?.content).toBe("inner");
  });

  test("does not search above the git root", async () => {
    const { sub } = await gitRepo();
    await writeFile(path.join(tmp, "CLAUDE.md"), "outside repo");
    const ctx = await loadContext(sub);
    expect(ctx.projectInstructions).toBeUndefined();
  });

  test("caps long instructions with a truncation notice", async () => {
    const { repo } = await gitRepo();
    await writeFile(path.join(repo, "AGENTS.md"), "x".repeat(9000));
    const ctx = await loadContext(repo);
    expect(ctx.projectInstructions!.content.length).toBeLessThan(8200);
    expect(ctx.projectInstructions!.content).toContain("[truncated");
  });

  test("loads memory when present and non-empty", async () => {
    await mkdir(path.join(tmp, ".lex"));
    await writeFile(path.join(tmp, ".lex", "memory.md"), "   ");
    expect((await loadContext(tmp)).memory).toBeUndefined();
    await writeFile(path.join(tmp, ".lex", "memory.md"), "- (2026-11-22) use bun\n");
    expect((await loadContext(tmp)).memory).toBe("- (2026-11-22) use bun");
  });

  test("not a git repo: no throw, only root is checked", async () => {
    const dir = path.join(tmp, "plain");
    await mkdir(dir);
    await writeFile(path.join(tmp, "AGENTS.md"), "parent");
    const ctx = await loadContext(dir);
    expect(ctx.gitBranch).toBeUndefined();
    expect(ctx.projectInstructions).toBeUndefined();
    await writeFile(path.join(dir, "CLAUDE.md"), "here");
    expect((await loadContext(dir)).projectInstructions?.content).toBe("here");
  });
});
