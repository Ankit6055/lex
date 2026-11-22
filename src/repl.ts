// The interactive loop: banner, prompt, slash commands, one turn at a time.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import pc from "picocolors";
import pkg from "../package.json" with { type: "json" };
import type { ApprovalMode, IO, ModelInfo } from "./types.ts";
import { createIO, closeIO, startSpinner, stopSpinner, writeWhenIdle } from "./io.ts";
import { createApprover } from "./approval.ts";
import { createSession, type Session } from "./session.ts";
import { ModelError, NO_KEY_MESSAGE, suggestedModels } from "./models.ts";
import { login, redact, saveConfig } from "./auth.ts";
import { loadContext } from "./context.ts";
import { createRenderer, formatFooter } from "./render.ts";
import { getTodoList, renderTodos } from "./tools/todo.ts";

export interface ReplOptions { root: string; model?: string; mode: ApprovalMode; maxSteps?: number }

const HELP = `Commands
  /model [spec|n]  show the model and a numbered list, or switch (history is kept)
  /undo            put back the files changed in the last turn
  /clear           start a fresh conversation
  /memory          show .lex/memory.md
  /todo            show the current todo list
  /usage           tokens, steps and time for this session
  /yolo            toggle: allow everything without asking
  /readonly        toggle: refuse writes, edits and non-safe bash
  /login           save an API key
  /help            this list
  /exit            quit (or Ctrl-D)
Ctrl-C cancels a running turn, clears a typed line, or exits on an empty prompt.`;

const tilde = (p: string) => (p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p);
const say = (s = "") => process.stderr.write(s + "\n");

async function readMemory(file: string): Promise<string> {
  return readFile(file, "utf8").then((s) => s.trim(), () => "");
}

/** Create the session; on a first run with no key, offer `login` right here. */
async function startSession(o: ReplOptions, io: IO): Promise<Session> {
  const approver = createApprover(io, o.mode);
  const make = () => createSession({ root: o.root, io, approver, model: o.model, maxSteps: o.maxSteps });
  try {
    return await make();
  } catch (e) {
    if (!(e instanceof ModelError && e.message === NO_KEY_MESSAGE && process.stdin.isTTY)) throw e;
    say(pc.yellow(NO_KEY_MESSAGE));
    say();
    if ((await io.confirm("Set up a key now? [y/n]")) === "n") throw e;
    await login(io);
    return make();
  }
}

async function banner(s: Session): Promise<void> {
  const ctx = await loadContext(s.root);
  const memory = await readMemory(s.memoryPath);
  const entries = memory ? memory.split("\n").filter((l) => l.startsWith("- ")).length : 0;
  const mode = s.approver.mode === "ask" ? "" : ` · mode: ${pc.yellow(s.approver.mode)}`;
  say(`${pc.bold("lex")} ${pc.dim(pkg.version)} · ${pc.cyan(s.model.spec)}${mode}`);
  say(pc.dim(`${tilde(s.root)}${ctx.gitBranch ? ` (${ctx.gitBranch})` : ""} · instructions: ${ctx.projectInstructions ? path.relative(s.root, ctx.projectInstructions.file) || ctx.projectInstructions.file : "none"} · memory: ${entries} ${entries === 1 ? "entry" : "entries"}`));
  say(pc.dim("/help for commands · Ctrl-C cancels a turn · Ctrl-D exits"));
  say();
}

export async function runRepl(o: ReplOptions): Promise<void> {
  // A real terminal gets the full interactive UI; pipes, CI and LEX_PLAIN=1 get this plain loop.
  if (process.stdin.isTTY && process.stdout.isTTY && !process.env.LEX_PLAIN) {
    const { runTui } = await import("./ui/app.ts");
    return runTui(o);
  }
  const io = createIO();
  const session = await startSession(o, io);
  await banner(session);

  let controller: AbortController | null = null;
  let lastList: ModelInfo[] = [];
  const onSigint = () => {
    if (controller && !controller.signal.aborted) controller.abort();
    else if (!controller) { closeIO(); process.exit(130); }
  };
  process.on("SIGINT", onSigint);

  const commands: Record<string, (arg: string) => Promise<boolean | void>> = {
    async help() { say(HELP); },
    async exit() { return true; },
    async quit() { return true; },
    async clear() {
      session.clear();
      say(pc.dim("Conversation cleared."));
    },
    async model(arg) {
      if (!arg) {
        lastList = await suggestedModels();
        say(`Current: ${pc.cyan(session.model.spec)}`);
        lastList.forEach((m, i) => say(`  ${pc.cyan(String(i + 1).padStart(2))}. ${m.spec}`));
        say(pc.dim("Switch with /model <n> or /model <spec>. Any gateway id works, e.g. /model zai/glm-5.3 (see: lex models)."));
        return;
      }
      const pick = /^\d+$/.test(arg) ? lastList[Number(arg) - 1]?.spec : arg;
      if (!pick) return say(pc.red(`No model #${arg}. Run /model to see the list.`));
      const m = await session.setModel(pick);
      await saveConfig({ defaultModel: m.spec });
      say(`Switched to ${pc.cyan(m.spec)} (saved as your default). History kept (${session.messages.length} messages).`);
    },
    async undo() {
      const r = await session.undo();
      if (!r) return say(pc.dim("Nothing to undo: no turn has changed files yet."));
      say(`Undid "${r.label}": ${[...r.restored.map((f) => `restored ${f}`), ...r.removed.map((f) => `removed ${f}`)].join(", ")}`);
    },
    async memory() {
      const memory = await readMemory(session.memoryPath);
      say(memory || pc.dim("(no memory yet; the agent saves durable facts with `remember`)"));
    },
    async todo() {
      const items = session.tools.todo ? getTodoList(session.tools.todo) : [];
      say(items.length ? renderTodos(items) : pc.dim("(no todos)"));
    },
    async usage() {
      const t = session.totals;
      say(`${t.turns} turn${t.turns === 1 ? "" : "s"} · ${t.toolCalls} tool call${t.toolCalls === 1 ? "" : "s"} · ${formatFooter(t, session.model.spec)}`);
    },
    async yolo() {
      session.approver.setMode(session.approver.mode === "yolo" ? "ask" : "yolo");
      say(`Mode: ${pc.yellow(session.approver.mode)}`);
    },
    async readonly() {
      session.approver.setMode(session.approver.mode === "readonly" ? "ask" : "readonly");
      say(`Mode: ${pc.yellow(session.approver.mode)}`);
    },
    async login() { await login(io); },
  };

  try {
    for (;;) {
      const line = await io.prompt(pc.bold(pc.cyan("› ")));
      if (line === null) break; // Ctrl-D, or Ctrl-C on an empty prompt
      const input = line.trim();
      if (!input) continue;

      if (input.startsWith("/")) {
        const [name = "", ...rest] = input.slice(1).split(/\s+/);
        const cmd = commands[name.toLowerCase()];
        if (!cmd) { say(pc.red(`Unknown command /${name}. Try /help.`)); continue; }
        try {
          if (await cmd(rest.join(" ").trim())) break;
        } catch (e) {
          say(pc.red(redact(e instanceof Error ? e.message : String(e))));
        }
        continue;
      }

      controller = new AbortController();
      const renderer = createRenderer({ spinner: { start: startSpinner, stop: stopSpinner }, writeErr: writeWhenIdle });
      try {
        const turn = await session.turn(input, { signal: controller.signal, onChunk: renderer.onChunk });
        renderer.footer(turn.usage, session.model.spec);
      } catch (e) {
        stopSpinner();
        say(pc.red(`Error: ${redact(e instanceof Error ? e.message : String(e))}`));
        say(pc.dim("The turn was rolled back; you can retry or switch models with /model."));
      } finally {
        controller = null;
      }
      say();
    }
  } finally {
    process.off("SIGINT", onSigint);
    closeIO();
  }
}
