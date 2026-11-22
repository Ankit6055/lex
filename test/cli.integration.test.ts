import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
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

function cliEnvironment(configDir: string) {
  return {
    PATH: process.env.PATH,
    LEX_HOME: configDir,
    NO_COLOR: "1",
    TMPDIR: workspace,
    TEMP: workspace,
    TMP: workspace,
  };
}

async function runCli(args: string[], configDir = config, input?: string) {
  const child = Bun.spawn(["node", bundle, ...args], {
    cwd: workspace,
    env: cliEnvironment(configDir),
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

type FixtureRequest = { model: string; messages: { role: string; content: unknown }[] };

function streamCompletion(model: string, deltas: object[], finishReason = "stop") {
  const chunk = { id: "chat-fixture", object: "chat.completion.chunk", created: 1, model };
  const events = [
    ...deltas.map((delta) => ({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })),
    { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
    { ...chunk, choices: [], usage: { prompt_tokens: 120, completion_tokens: 2, total_tokens: 122 } },
  ];
  const body = [...events.map((event) => JSON.stringify(event)), "[DONE]"]
    .map((event) => `data: ${event}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function streamWrite(model: string, content: string) {
  return streamCompletion(model, [{
    role: "assistant",
    tool_calls: [{
      index: 0, id: "call_write_note", type: "function",
      function: { name: "write", arguments: JSON.stringify({ path: "note.txt", content }) },
    }],
  }], "tool_calls");
}

async function withProvider(
  respond: (body: FixtureRequest) => Response,
  run: (dir: string, requests: { path: string; body: FixtureRequest }[]) => Promise<void>,
) {
  const requests: { path: string; body: FixtureRequest }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as FixtureRequest;
      requests.push({ path: new URL(request.url).pathname, body });
      return respond(body);
    },
  });
  try {
    const dir = await mkdtemp(path.join(workspace, "provider-"));
    await writeFile(path.join(dir, "config.json"), JSON.stringify({
      defaultModel: "fixture:fixture-model",
      providers: { fixture: { baseURL: new URL("/v1", server.url).href } },
    }));
    await run(dir, requests);
  } finally {
    await server.stop(true);
  }
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
  await withProvider(
    ({ model }) => streamCompletion(model, [{ role: "assistant", content: "Fixture " }, { content: "answer" }]),
    async (providerConfig, requests) => {
      const project = await mkdtemp(path.join(workspace, "project-"));
      await writeFile(path.join(project, "AGENTS.md"), "Use the fixture glossary.");

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
    },
  );
});

test("compare runs both models in isolated copies and reports each model's diff", async () => {
  await withProvider(
    ({ model, messages }) => messages.some(({ role }) => role === "tool")
      ? streamCompletion(model, [{ content: `Finished ${model}` }])
      : streamWrite(model, `Written by ${model}\n`),
    async (providerConfig, requests) => {
      const project = await mkdtemp(path.join(workspace, "compare-project-"));
      await writeFile(path.join(project, "note.txt"), "Original note\n");

      const args = ["--cwd", project, "compare", "--diff", "--models", "fixture:alpha,fixture:beta", "Update the note"];
      const result = await runCli(args, providerConfig);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/fixture:alpha\s+done/);
      expect(result.stdout).toMatch(/fixture:beta\s+done/);
      expect(result.stdout).toContain("Finished alpha");
      expect(result.stdout).toContain("Finished beta");
      const output = stripVTControlCharacters(result.stdout);
      expect(output).toContain("+Written by alpha");
      expect(output).toContain("+Written by beta");

      const copies = [...output.matchAll(/^copy: (.+)$/gm)].map(([, copy]) => copy!);
      const root = await realpath(workspace);
      expect(copies).toHaveLength(2);
      expect(new Set(copies).size).toBe(2);
      for (const copy of copies) expect(path.dirname(await realpath(copy))).toBe(root);
      expect(await readFile(path.join(copies[0]!, "note.txt"), "utf8")).toBe("Written by alpha\n");
      expect(await readFile(path.join(copies[1]!, "note.txt"), "utf8")).toBe("Written by beta\n");
      expect(await readFile(path.join(project, "note.txt"), "utf8")).toBe("Original note\n");
      expect(requests.map(({ body }) => body.model).sort()).toEqual(["alpha", "alpha", "beta", "beta"]);
    },
  );
});

test("compare still reports a successful model when the other provider request fails", async () => {
  await withProvider(
    ({ model }) => model === "broken"
      ? Response.json({ error: { message: "Fixture model rejected the request" } }, { status: 400 })
      : streamCompletion(model, [{ content: "Healthy model answered." }]),
    async (providerConfig, requests) => {
      const project = await mkdtemp(path.join(workspace, "compare-failure-"));
      const result = await runCli([
        "--cwd", project, "compare", "--models", "fixture:broken,fixture:healthy", "Say hello",
      ], providerConfig);

      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/fixture:broken\s+error/);
      expect(result.stdout).toMatch(/fixture:healthy\s+done/);
      expect(result.stdout).toContain("Fixture model rejected the request");
      expect(result.stdout).toContain("Healthy model answered.");
      expect(requests.map(({ body }) => body.model).sort()).toEqual(["broken", "healthy"]);
    },
  );
});

test.skipIf(process.platform === "win32")("Ctrl-C at a TTY approval cancels the write and the REPL accepts the next turn", async () => {
  await withProvider(
    ({ model, messages }) => messages.some(({ content }) => content === "Follow up")
      ? streamCompletion(model, [{ content: "Follow-up succeeded." }])
      : streamWrite(model, "Unexpected write\n"),
    async (providerConfig, requests) => {
      const project = await mkdtemp(path.join(workspace, "tty-project-"));
      const note = path.join(project, "note.txt");
      await writeFile(note, "Original note\n");
      const decoder = new TextDecoder();
      let transcript = "";
      const steps = [
        { waitingFor: /› $/, input: "Change the note\n" },
        { waitingFor: /Allow write:.*\[a\]lways/, input: "\x03" },
        { waitingFor: /\(aborted\)[\s\S]*› $/, input: "Follow up\n" },
        { waitingFor: /Follow-up succeeded\.[\s\S]*› $/, input: "/exit\n" },
      ];
      let step = 0;
      const child = Bun.spawn(["node", bundle, "--cwd", project], {
        cwd: workspace,
        // The plain readline REPL; the full-screen UI has its own test (test/tui.test.ts).
        env: { ...cliEnvironment(providerConfig), LEX_PLAIN: "1" },
        timeout: 4000,
        killSignal: "SIGKILL",
        terminal: {
          data(terminal, bytes) {
            transcript += decoder.decode(bytes, { stream: true });
            const next = steps[step];
            if (next?.waitingFor.test(stripVTControlCharacters(transcript))) {
              step++;
              terminal.write(next.input);
            }
          },
        },
      });
      try {
        expect({ code: await child.exited, steps: step, transcript }).toMatchObject({ code: 0, steps: steps.length });
        expect(await readFile(note, "utf8")).toBe("Original note\n");
        expect(requests).toHaveLength(2);
        expect(requests[1]!.body.messages).toContainEqual(expect.objectContaining({
          role: "assistant", content: expect.stringContaining("The user cancelled this request"),
        }));
      } finally {
        child.terminal?.close();
      }
    },
  );
});
