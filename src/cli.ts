#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpath } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import pkg from "../package.json" with { type: "json" };
import type { ApprovalMode } from "./types.ts";
import { ModelError, NO_KEY_MESSAGE, listAvailable } from "./models.ts";
import { login, redact } from "./auth.ts";
import { createRenderer } from "./render.ts";
import { createIO, startSpinner, stopSpinner } from "./io.ts";
import { createApprover } from "./approval.ts";
import { createSession } from "./session.ts";
import { runRepl } from "./repl.ts";
import { runCompare } from "./compare.ts";

const HELP = `lex ${pkg.version}: a minimal, open-source AI coding harness

Usage
  lex                              interactive session in the current directory
  lex "fix the failing test"       one-shot: run, print, exit
  lex compare --models a,b "task"
  lex login                        save an API key to ~/.lex/auth.json
  lex models                       list models your keys can reach

Options
  -m, --model <spec>   gateway:anthropic/claude-sonnet-5.5 | anthropic:claude-sonnet-5-5 | openai:gpt-6.2-sol
      --yolo           allow every bash/write/edit without asking
      --readonly       refuse writes, edits and non-safe bash
      --cwd <dir>      project root (default: current directory)
      --max-steps <n>  tool-loop step cap (default 25)
  -v, --version
  -h, --help

Keys: AI_GATEWAY_API_KEY (recommended), ANTHROPIC_API_KEY, OPENAI_API_KEY, or \`lex login\`.`;

function fail(msg: string, code = 1): never {
  process.stderr.write(pc.red(redact(msg)) + "\n");
  process.exit(code);
}

async function oneShot(o: { root: string; prompt: string; model?: string; mode: ApprovalMode; maxSteps?: number }) {
  const io = createIO();
  const session = await createSession({ root: o.root, io, approver: createApprover(io, o.mode), model: o.model, maxSteps: o.maxSteps });
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  const renderer = createRenderer({ spinner: { start: startSpinner, stop: stopSpinner } });
  try {
    const turn = await session.turn(o.prompt, { signal: controller.signal, onChunk: renderer.onChunk });
    renderer.footer(turn.usage, session.model.spec);
    return turn.aborted ? 130 : 0;
  } finally {
    stopSpinner();
    process.off("SIGINT", onSigint);
  }
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        model: { type: "string", short: "m" },
        models: { type: "string" },
        yolo: { type: "boolean" },
        readonly: { type: "boolean" },
        cwd: { type: "string" },
        "max-steps": { type: "string" },
        diff: { type: "boolean" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    fail(`${(e as Error).message}\nRun lex --help for usage.`);
  }
  const { values: v, positionals } = parsed;

  if (v.version) return void console.log(pkg.version), 0;
  if (v.help) return void console.log(HELP), 0;
  if (v.yolo && v.readonly) fail("--yolo and --readonly can't be used together.");

  const mode: ApprovalMode = v.yolo ? "yolo" : v.readonly ? "readonly" : "ask";
  const maxSteps = v["max-steps"] ? Number.parseInt(v["max-steps"], 10) : undefined;
  if (maxSteps !== undefined && !(maxSteps > 0)) fail("--max-steps must be a positive integer.");
  let root: string;
  try {
    root = await realpath(path.resolve(v.cwd ?? process.cwd()));
  } catch {
    fail(`No such directory: ${v.cwd}`);
  }

  const [sub, ...rest] = positionals;
  switch (sub) {
    case "login":
      await login(createIO());
      return 0;
    case "models": {
      const models = await listAvailable();
      if (!models.length) fail(NO_KEY_MESSAGE);
      for (const m of models) console.log(m.spec);
      return 0;
    }
    case "compare": {
      const models = (v.models ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (models.length < 2 || !rest.length) fail('Usage: lex compare --models a,b "task"');
      await runCompare({ root, models, task: rest.join(" "), diff: v.diff, maxSteps });
      return 0;
    }
  }

  if (!positionals.length) {
    await runRepl({ root, model: v.model, mode, maxSteps });
    return 0;
  }
  return oneShot({ root, prompt: positionals.join(" "), model: v.model, mode, maxSteps });
}

main().then(
  (code) => process.exit(code),
  (e) => fail(e instanceof ModelError ? e.message : `Error: ${e instanceof Error ? e.message : String(e)}`),
);
