import * as readline from "node:readline";
import { Writable } from "node:stream";
import pc from "picocolors";
import type { IO } from "./types.ts";

/*
 * Terminal I/O for lex.
 *
 * - Exactly ONE readline interface, created lazily on the first prompt and shared by every IO method.
 *   Lines are queued as they arrive, so piped stdin (`printf 'a\nb\n' | lex`) never loses lines.
 * - Prompts are written to stderr, so stdout stays clean for the model's answer (`lex "..." > out.txt`).
 * - Between prompts the interface is paused and raw mode is switched off, so Ctrl-C reaches the process
 *   as a normal SIGINT (the REPL uses that to abort a turn).
 * - A small spinner (`startSpinner` / `stopSpinner`) that `withPaused` stops around prompts.
 */

// ---------------------------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------------------------

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerLabel = "";
let spinnerFrame = 0;

function drawSpinner(): void {
  const frame = FRAMES[spinnerFrame++ % FRAMES.length];
  process.stderr.write(`\r\x1b[K${pc.cyan(frame ?? "")} ${pc.dim(spinnerLabel)}`);
}

/**
 * Start (or relabel) the spinner on stderr. Does nothing when stderr isn't a TTY.
 * Safe to call repeatedly: a running spinner just gets the new label.
 */
export function startSpinner(label = "thinking"): void {
  spinnerLabel = label;
  if (!process.stderr.isTTY) return;
  if (spinnerTimer) return;
  spinnerFrame = 0;
  drawSpinner();
  spinnerTimer = setInterval(drawSpinner, 80);
  spinnerTimer.unref?.();
}

/** Stop the spinner and clear its line. Safe to call when no spinner is running. */
export function stopSpinner(): void {
  if (!spinnerTimer) return;
  clearInterval(spinnerTimer);
  spinnerTimer = null;
  process.stderr.write("\r\x1b[K");
}

/** True while the spinner is drawing. */
export function isSpinning(): boolean {
  return spinnerTimer !== null;
}

// ---------------------------------------------------------------------------------------------
// The single shared readline interface
// ---------------------------------------------------------------------------------------------

/** stderr wrapper whose writes can be muted (used to hide typed characters in `secret`). */
let muted = false;
const output = new Writable({
  write(chunk, encoding, cb) {
    if (!muted) process.stderr.write(chunk, encoding);
    cb();
  },
});
// readline checks these to decide on terminal mode and line width.
Object.defineProperty(output, "isTTY", { get: () => process.stderr.isTTY });
Object.defineProperty(output, "columns", { get: () => process.stderr.columns });

let rl: readline.Interface | null = null;
let inputEnded = false; // stdin hit EOF for good (piped input); every later read returns null
const lineQueue: string[] = [];
let waiter: ((line: string | null) => void) | null = null;

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}

function setRaw(on: boolean): void {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    try {
      process.stdin.setRawMode(on);
    } catch {
      /* ignore */
    }
  }
}

function settle(line: string | null): void {
  const w = waiter;
  waiter = null;
  if (w) w(line);
}

function getRl(): readline.Interface {
  if (rl) return rl;
  const r = readline.createInterface({
    input: process.stdin,
    output,
    terminal: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    historySize: 100,
  });
  r.on("line", (line) => {
    if (waiter) settle(line);
    else lineQueue.push(line);
  });
  r.on("close", () => {
    rl = null;
    // A TTY can be reopened after Ctrl-D; a pipe can't.
    if (!process.stdin.isTTY) inputEnded = true;
    if (waiter) process.stderr.write("\n");
    settle(null);
  });
  r.on("SIGINT", () => {
    if (waiter && r.line) {
      // Ctrl-C with text typed clears the line (like a shell); on an empty line it cancels/exits.
      r.write(null, { ctrl: true, name: "e" });
      r.write(null, { ctrl: true, name: "u" });
      return;
    }
    if (waiter) {
      process.stderr.write(pc.dim("^C") + "\n");
      settle(null);
      // Also tell the process: mid-turn (e.g. at an approval prompt) Ctrl-C cancels the whole turn.
      process.emit("SIGINT");
    } else {
      process.kill(process.pid, "SIGINT");
    }
  });
  rl = r;
  return r;
}

/** Pause input between prompts so Ctrl-C works normally and the process can exit. */
function idle(): void {
  if (!rl) return;
  rl.pause();
  setRaw(false);
}

/**
 * Read one line. `label` may span several lines: all but the last are written directly and the
 * last becomes the readline prompt. Returns null on EOF / Ctrl-D / Ctrl-C.
 */
function readLine(label: string, opts: { mask?: boolean } = {}): Promise<string | null> {
  const nl = label.lastIndexOf("\n");
  const head = nl >= 0 ? label.slice(0, nl + 1) : "";
  const last = nl >= 0 ? label.slice(nl + 1) : label;

  if (waiter) return Promise.reject(new Error("io: a prompt is already waiting for input"));

  if (lineQueue.length > 0) {
    // Piped input that arrived before we asked: echo the prompt so transcripts read sensibly.
    process.stderr.write(head + last + "\n");
    return Promise.resolve(lineQueue.shift() ?? "");
  }
  if (inputEnded) return Promise.resolve(null);
  const r = getRl();

  return new Promise<string | null>((resolve) => {
    waiter = (line) => {
      if (opts.mask) {
        muted = false;
        if (process.stdin.isTTY) process.stderr.write("\n");
      }
      idle();
      resolve(line);
    };
    if (head) process.stderr.write(head);
    if (opts.mask) {
      process.stderr.write(last);
      r.setPrompt("");
      muted = true;
    } else {
      r.setPrompt(last);
    }
    setRaw(true);
    r.resume();
    r.prompt();
  });
}

/** Close the shared readline interface (call on exit so the terminal is restored). */
export function closeIO(): void {
  stopSpinner();
  if (rl) rl.close();
  rl = null;
}

// ---------------------------------------------------------------------------------------------
// IO implementation
// ---------------------------------------------------------------------------------------------

function info(msg: string): void {
  if (spinnerTimer) process.stderr.write("\r\x1b[K");
  process.stderr.write(pc.dim(msg) + "\n");
}

async function withPaused<T>(fn: () => Promise<T>): Promise<T> {
  const wasSpinning = spinnerTimer !== null;
  const label = spinnerLabel;
  if (wasSpinning) stopSpinner();
  try {
    return await fn();
  } finally {
    if (wasSpinning) startSpinner(label);
  }
}

async function confirm(question: string): Promise<"y" | "n" | "a"> {
  if (!isInteractive()) {
    process.stderr.write(question + "\n");
    info("Denied: no interactive terminal to ask for approval (stdin is not a TTY). Use --yolo to allow, or run in a terminal.");
    return "n";
  }
  const answer = await readLine(`${question} `);
  const a = (answer ?? "").trim().toLowerCase();
  if (a === "y" || a === "yes") return "y";
  if (a === "a" || a === "always") return "a";
  return "n";
}

async function choose(question: string, options: string[]): Promise<string> {
  if (options.length === 0) return (await prompt(`${question} `)) ?? "";
  if (!isInteractive()) {
    // Never guess an answer on the user's behalf: a guessed "retry" can loop a denied action.
    throw new Error("no interactive terminal (stdin is not a TTY), so nobody can answer");
  }
  const lines = options.map((o, i) => `  ${pc.cyan(String(i + 1))}. ${o}`).join("\n");
  let label = `${pc.bold(question)}\n${lines}\n${pc.dim(`Pick 1-${options.length} or type an answer:`)} `;
  for (;;) {
    const answer = await readLine(label);
    if (answer === null) return "";
    const a = answer.trim();
    if (/^\d+$/.test(a)) {
      const n = Number(a);
      if (n >= 1 && n <= options.length) return options[n - 1] ?? a;
    }
    if (a) return a;
    label = `${pc.dim(`Pick 1-${options.length} or type an answer:`)} `;
  }
}

function prompt(label: string): Promise<string | null> {
  return readLine(label);
}

async function secret(label: string): Promise<string> {
  const answer = await readLine(label, { mask: true });
  return (answer ?? "").trim();
}

const io: IO = { confirm, choose, prompt, secret, withPaused, info };

/** The process-wide IO (there is only one stdin, so every caller shares the same instance). */
export function createIO(): IO {
  return io;
}
