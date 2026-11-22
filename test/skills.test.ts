import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverSkills, loadSkill, parseSkill, SKILL_DESCRIPTION_MAX_CHARS } from "../src/skills.ts";
import { createLoadSkillTool, SKILL_MAX_CHARS } from "../src/tools/skill.ts";
import { loadContext } from "../src/context.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import type { ToolContext } from "../src/types.ts";

let root: string;
let home: string;
let prevHome: string | undefined;

async function addSkill(base: string, dir: string, content: string) {
  await mkdir(path.join(base, "skills", dir), { recursive: true });
  await writeFile(path.join(base, "skills", dir, "SKILL.md"), content);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "lex-skills-root-")));
  home = await realpath(await mkdtemp(path.join(tmpdir(), "lex-skills-home-")));
  prevHome = process.env.LEX_HOME;
  process.env.LEX_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.LEX_HOME;
  else process.env.LEX_HOME = prevHome;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("parseSkill", () => {
  test("reads name and description from frontmatter and strips it from the body", () => {
    const s = parseSkill("---\nname: release\ndescription: \"Cut a release\"\n---\n\n# Release\nStep 1\n", "dir");
    expect(s).toEqual({ name: "release", description: "Cut a release", body: "# Release\nStep 1" });
  });

  test("handles CRLF, a BOM and folded block descriptions", () => {
    const s = parseSkill("﻿---\r\nname: x\r\ndescription: >\r\n  line one\r\n  line two\r\n---\r\nbody\r\n", "dir");
    expect(s.name).toBe("x");
    expect(s.description).toBe("line one line two");
    expect(s.body).toBe("body");
  });

  test("falls back to the directory name and first non-empty body line", () => {
    const s = parseSkill("\n\n## Write good tests\nMore text", "write-tests");
    expect(s.name).toBe("write-tests");
    expect(s.description).toBe("Write good tests");
  });

  test("caps long descriptions", () => {
    const s = parseSkill(`---\ndescription: ${"a".repeat(500)}\n---\nbody`, "d");
    expect(s.description.length).toBe(SKILL_DESCRIPTION_MAX_CHARS);
    expect(s.description.endsWith("…")).toBe(true);
  });
});

describe("discoverSkills", () => {
  test("finds project and home skills, project wins on a name clash, sorted by name", async () => {
    await addSkill(root, "deploy", "---\nname: deploy\ndescription: project deploy\n---\nproject body");
    await addSkill(root, "zeta", "Zeta skill");
    await addSkill(home, "deploy", "---\nname: deploy\ndescription: home deploy\n---\nhome body");
    await addSkill(home, "alpha", "---\ndescription: home alpha\n---\nalpha body");
    await mkdir(path.join(root, "skills", "not-a-skill"), { recursive: true }); // no SKILL.md
    await writeFile(path.join(root, "skills", "README.md"), "stray file");

    const skills = await discoverSkills(root);
    expect(skills.map((s) => [s.name, s.description, s.source])).toEqual([
      ["alpha", "home alpha", "user"],
      ["deploy", "project deploy", "project"],
      ["zeta", "Zeta skill", "project"],
    ]);
  });

  test("returns [] when there are no skill directories", async () => {
    expect(await discoverSkills(root)).toEqual([]);
  });

  test("loadContext fills skills only when some exist, and the prompt lists them", async () => {
    expect((await loadContext(root)).skills).toBeUndefined();
    await addSkill(root, "deploy", "---\ndescription: Ship it\n---\nbody");
    const ctx = await loadContext(root);
    expect(ctx.skills).toEqual([{ name: "deploy", description: "Ship it" }]);
    const p = buildSystemPrompt({ ...ctx, toolNames: ["read", "load_skill"] });
    expect(p).toContain("<skills>\n- deploy: Ship it\n</skills>");
    expect(p).toContain("load_skill");
  });
});

describe("load_skill tool", () => {
  const run = (name: string) => {
    const ctx = { root, memoryPath: path.join(root, ".lex", "memory.md") } as ToolContext;
    return (createLoadSkillTool(ctx).execute as any)({ name }, { toolCallId: "t", messages: [] }) as Promise<string>;
  };

  test("returns the body without frontmatter", async () => {
    await addSkill(root, "deploy", "---\nname: deploy\ndescription: d\n---\nRun `make ship`.\n");
    expect(await run("deploy")).toBe("# Skill: deploy\n\nRun `make ship`.");
    expect(await loadSkill(root, "DEPLOY")).toMatchObject({ name: "deploy" });
  });

  test("loads home skills", async () => {
    await addSkill(home, "lint", "Lint everything");
    expect(await run("lint")).toContain("Lint everything");
  });

  test("caps long bodies with a notice", async () => {
    await addSkill(root, "big", `---\ndescription: big\n---\n${"x".repeat(SKILL_MAX_CHARS + 500)}`);
    const out = await run("big");
    expect(out).toContain(`[truncated: showing first ${SKILL_MAX_CHARS}`);
    expect(out.length).toBeLessThan(SKILL_MAX_CHARS + 200);
  });

  test("unknown names list the available skills", async () => {
    await addSkill(root, "deploy", "d");
    await addSkill(home, "lint", "l");
    expect(await run("nope")).toBe('Error: unknown skill "nope". Available skills: deploy, lint.');
  });

  test("with no skills at all, says so", async () => {
    expect(await run("nope")).toMatch(/^Error: unknown skill "nope"\. No skills are installed/);
  });
});
