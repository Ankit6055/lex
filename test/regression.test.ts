import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";
import { contextFor } from "../src/agent.ts";
import { getKey, getProviders, readConfig, saveKey } from "../src/auth.ts";
import { loadContext } from "../src/context.ts";
import { resolveModel } from "../src/models.ts";

function readExchange(id: string, body: string): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: { path: "notes.txt" } }],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: id, toolName: "read", output: { type: "text", value: body } }],
    },
  ];
}

test("oversized turns prune old tool exchanges and preserve the five most recent pairs", () => {
  const oldText: ModelMessage = { role: "assistant", content: [{ type: "text", text: "I found the entry point." }] };
  const history: ModelMessage[] = [{ role: "user", content: "Read the repository." }];
  const olderExchange = readExchange("old-read", "x".repeat(410_000));
  const recent = Array.from({ length: 5 }, (_, index) =>
    readExchange(`recent-read-${index}`, `recent contents ${index}`),
  ).flat();
  const turn = [oldText, ...olderExchange, ...recent];
  const originalTurn = structuredClone(turn);

  expect(contextFor(history, turn)).toEqual([...history, oldText, ...recent]);
  expect(turn).toEqual(originalTurn);
});

test("project instructions resolve from the Git root through a checkout alias", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "lex-context-regression-"));
  try {
    const repo = path.join(await realpath(temp), "checkout");
    const alias = path.join(temp, "alias");
    await mkdir(path.join(repo, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await writeFile(path.join(repo, "AGENTS.md"), "Project-wide instructions.\n");
    await symlink(repo, alias, "junction");

    const cwd = path.join(alias, "src");
    const context = await loadContext(cwd);

    expect(context.cwd).toBe(cwd);
    expect(context.projectInstructions).toEqual({
      file: path.join(repo, "AGENTS.md"),
      content: "Project-wide instructions.",
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

describe("configuration regressions", () => {
  const keyEnv = "LEX_REGRESSION_CUSTOM_KEY";
  const envNames = ["LEX_HOME", "LEX_MODEL", keyEnv] as const;
  let home: string;
  let previous: (string | undefined)[];

  beforeEach(async () => {
    previous = envNames.map((name) => process.env[name]);
    home = await mkdtemp(path.join(tmpdir(), "lex-config-regression-"));
    process.env.LEX_HOME = home;
    delete process.env.LEX_MODEL;
    delete process.env[keyEnv];
  });

  afterEach(async () => {
    envNames.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
    await rm(home, { recursive: true, force: true });
  });

  test("saving a custom provider key preserves existing credentials and repairs legacy file permissions", async () => {
    const config = { providers: { custom: { baseURL: "https://example.invalid/v1", apiKeyEnv: keyEnv } } };
    const stored = { openai: { type: "api_key", key: "previous-placeholder" } };
    const authFile = path.join(home, "auth.json");
    await writeFile(path.join(home, "config.json"), JSON.stringify(config));
    await writeFile(authFile, JSON.stringify(stored));
    await chmod(authFile, 0o644);

    await saveKey("custom", "  new-placeholder  ");

    expect((await stat(authFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(authFile, "utf8"))).toEqual({
      ...stored,
      custom: { type: "api_key", key: "new-placeholder" },
    });
    process.env[keyEnv] = " \t ";
    expect(await getKey("custom")).toBe("new-placeholder");
    process.env[keyEnv] = "  env-placeholder  ";
    expect(await getKey("custom")).toBe("env-placeholder");
  });

  test("an invalid config falls back to the built-in registry", async () => {
    await writeFile(path.join(home, "config.json"), '{"providers":');

    expect(await readConfig()).toEqual({});
    expect(await getProviders()).toContainEqual(expect.objectContaining({ id: "ollama", local: true }));
  });

  test("explicit model beats LEX_MODEL, which beats the configured default", async () => {
    await writeFile(path.join(home, "config.json"), JSON.stringify({
      defaultModel: "custom:configured",
      providers: { custom: { baseURL: "https://example.invalid/v1" } },
    }));

    expect((await resolveModel()).spec).toBe("custom:configured");
    process.env.LEX_MODEL = "custom:environment";
    expect((await resolveModel()).spec).toBe("custom:environment");
    expect((await resolveModel("custom:explicit")).spec).toBe("custom:explicit");
  });
});
