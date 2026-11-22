import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pkg from "../package.json" with { type: "json" };

let workspace: string;
let bundle: string;
let config: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "lex-cli-test-"));
  bundle = path.join(workspace, "cli.mjs");
  config = path.join(workspace, "config");
  await mkdir(config);
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "../src/cli.ts")],
    target: "node",
    outdir: workspace,
    naming: "cli.mjs",
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
});

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

async function runCli(args: string[], configDir = config, input?: string) {
  const child = Bun.spawn(["node", bundle, ...args], {
    cwd: workspace,
    env: { PATH: process.env.PATH, LEX_HOME: configDir, NO_COLOR: "1" },
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(4000),
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("the bundled CLI prints version and help on stdout without a provider", async () => {
  expect(await runCli(["--version"])).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: "" });
  const help = await runCli(["--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("lex compare --models a,b");
  expect(help.stdout).toContain("Providers");
  expect(help.stderr).toBe("");
});

test.each([
  [["--yolo", "--readonly"], "can't be used together"],
  [["--max-steps", "0"], "--max-steps must be a positive integer"],
  [["--cwd", "missing-project"], "No such directory: missing-project"],
  [["compare", "--models", "ollama:one", "Summarize"], "Usage: lex compare"],
] as const)("rejects invalid CLI arguments %j before starting a turn", async (args, message) => {
  const result = await runCli([...args]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(message);
});

test("a one-shot request without credentials exits with setup instructions", async () => {
  const result = await runCli(["Summarize the project"]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("No API key found");
  expect(result.stderr).toContain("lex login");
});

test("the REPL processes piped commands, switches models, and exits cleanly", async () => {
  const result = await runCli(["--model", "ollama:initial"], config, [
    "/model ollama:replacement",
    "/usage",
    "/exit",
    "/help",
    "",
  ].join("\n"));

  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Switched to ollama:replacement");
  expect(result.stderr).toMatch(/0 turns · 0 tool calls · [^\n]*ollama:replacement/);
  expect(result.stderr).not.toContain("show the model and a numbered list");
});

test("one-shot mode streams the configured provider's answer and loads instructions from --cwd", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({ path: new URL(request.url).pathname, body: await request.json() });
      const chunk = { id: "chat-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model" };
      const events = [
        {
          ...chunk,
          choices: [{ index: 0, delta: { role: "assistant", content: "Fixture " }, finish_reason: null }],
        },
        {
          ...chunk,
          choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }],
        },
        {
          ...chunk,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
        {
          ...chunk,
          choices: [],
          usage: { prompt_tokens: 120, completion_tokens: 2, total_tokens: 122 },
        },
      ];
      const body = [...events.map((event) => JSON.stringify(event)), "[DONE]"]
        .map((event) => `data: ${event}\n\n`).join("");
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  try {
    const project = path.join(workspace, "project");
    const providerConfig = path.join(workspace, "provider-config");
    await Promise.all([mkdir(project), mkdir(providerConfig)]);
    await Promise.all([
      writeFile(path.join(project, "AGENTS.md"), "Use the fixture glossary."),
      writeFile(path.join(providerConfig, "config.json"), JSON.stringify({
        defaultModel: "fixture:fixture-model",
        providers: { fixture: { baseURL: new URL("/v1", server.url).href } },
      })),
    ]);

    const result = await runCli(["--readonly", "--cwd", project, "Say hello"], providerConfig);
    expect(result).toMatchObject({ code: 0, stderr: expect.stringContaining("fixture:fixture-model") });
    expect(result.stdout.trim()).toBe("Fixture answer");
    expect(requests).toEqual([{
      path: "/v1/chat/completions",
      body: expect.objectContaining({
        model: "fixture-model",
        stream: true,
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "system", content: expect.stringContaining("Use the fixture glossary.") }),
          expect.objectContaining({ role: "user", content: "Say hello" }),
        ]),
      }),
    }]);
  } finally {
    await server.stop(true);
  }
});
