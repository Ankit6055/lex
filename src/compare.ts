// `lex compare`: the same task on N models, each in its own throwaway copy of the project.
import { cp, mkdtemp, mkdir, appendFile, symlink, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import pc from "picocolors";
import type { IO } from "./types.ts";
import { createApprover } from "./approval.ts";
import { createSession } from "./session.ts";
import { callLabel, resultSuffix } from "./render.ts";
import { redact } from "./auth.ts";
import { resolveModel } from "./models.ts";

const run = promisify(execFile);

export interface CompareOptions { root: string; models: string[]; task: string; diff?: boolean; maxSteps?: number }

/** Heavy or generated directories that are never copied. node_modules is symlinked back instead. */
const SKIP = new Set(["node_modules", ".git", "dist", ".next", ".turbo", "coverage"]);

interface Outcome {
  spec: string;
  dir?: string;
  steps: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  status: "done" | "step cap" | "error" | "aborted";
  error?: string;
  text: string;
  diffStat: string;
  diff: string;
}

/** Non-interactive IO for a headless run: nothing can be asked, nothing is printed. */
const silentIO: IO = {
  async confirm() { return "y"; },
  async choose() { throw new Error("headless compare run, so nobody can answer"); },
  async prompt() { return null; },
  async secret() { return ""; },
  withPaused: (fn) => fn(),
  info() {},
};

const git = (dir: string, ...args: string[]) =>
  run("git", ["-c", "user.name=lex", "-c", "user.email=lex@localhost", "-c", "commit.gpgsign=false", ...args], { cwd: dir, maxBuffer: 32 * 1024 * 1024 });

/** Copy the project into a temp dir and commit it, so `git diff` later shows exactly what the model changed. */
async function makeCopy(root: string, spec: string): Promise<string> {
  const slug = spec.replace(/[^a-zA-Z0-9.-]+/g, "-").slice(0, 60);
  const dir = await mkdtemp(path.join(tmpdir(), `lex-${slug}-`));
  await cp(root, dir, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) || src === root });
  await git(dir, "init", "-q");
  // Dependencies: link instead of copying, and keep the link out of the diff.
  const nm = path.join(root, "node_modules");
  if (await stat(nm).then((s) => s.isDirectory(), () => false)) {
    await symlink(nm, path.join(dir, "node_modules"), "dir");
  }
  await mkdir(path.join(dir, ".git", "info"), { recursive: true });
  await appendFile(path.join(dir, ".git", "info", "exclude"), "node_modules\n.lex/\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "--allow-empty", "-m", "lex compare: starting point");
  return dir;
}

async function runOne(o: CompareOptions, spec: string, signal: AbortSignal, label: string): Promise<Outcome> {
  const out: Outcome = { spec, steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, ms: 0, status: "error", text: "", diffStat: "", diff: "" };
  const start = Date.now();
  const calls = new Map<string, { name: string; input: unknown }>();
  try {
    out.spec = (await resolveModel(spec)).spec; // validate the spec before copying anything
    out.dir = await makeCopy(o.root, out.spec);
    const copy = await createSession({ root: out.dir, io: silentIO, approver: createApprover(silentIO, "yolo"), model: out.spec, maxSteps: o.maxSteps, checkpoints: false });
    const turn = await copy.turn(o.task, {
      signal,
      onChunk: (c) => {
        if (c.type === "tool-call") calls.set(c.toolCallId, { name: c.toolName, input: c.input });
        if (c.type === "tool-result") {
          const call = calls.get(c.toolCallId);
          const name = call?.name ?? c.toolName;
          process.stderr.write(`${label} ${pc.dim(`● ${callLabel(name, call?.input ?? c.input)}`)}${resultSuffix(name, call?.input ?? c.input, c.output)}\n`);
        }
      },
    });
    Object.assign(out, {
      steps: turn.usage.steps,
      toolCalls: turn.usage.toolCalls,
      inputTokens: turn.usage.inputTokens,
      outputTokens: turn.usage.outputTokens,
      text: turn.text.trim(),
      status: turn.aborted ? "aborted" : turn.usage.steps >= (o.maxSteps ?? 25) ? "step cap" : "done",
    });
  } catch (e) {
    out.error = redact(e instanceof Error ? e.message : String(e));
  }
  out.ms = Date.now() - start;
  if (out.dir) {
    try {
      await git(out.dir, "add", "-A");
      out.diffStat = (await git(out.dir, "diff", "--cached", "--stat")).stdout.trim();
      if (o.diff) out.diff = (await git(out.dir, "diff", "--cached", "--color=always")).stdout.trim();
    } catch { /* leave empty */ }
  }
  process.stderr.write(`${label} ${out.status === "done" ? pc.green("finished") : pc.yellow(out.status)}${out.error ? pc.red(` ${out.error.split("\n")[0]}`) : ""}\n`);
  return out;
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r, ri) => {
    const line = r.map((c, i) => c.padEnd(widths[i]!)).join("  ");
    return ri === 0 ? pc.bold(line) : line;
  }).join("\n");
}

export async function runCompare(o: CompareOptions): Promise<void> {
  const say = (s = "") => process.stderr.write(s + "\n");
  say(pc.bold(`lex compare · ${o.models.length} models · "${o.task}"`));
  say(pc.yellow("Each model runs unattended (no approval prompts) in its own temp copy of this project. Your files are not touched."));
  say();

  const controller = new AbortController();
  const onSigint = () => (controller.signal.aborted ? process.exit(130) : controller.abort());
  process.on("SIGINT", onSigint);

  const colors = [pc.cyan, pc.magenta, pc.yellow, pc.green, pc.blue];
  const labels = o.models.map((m, i) => colors[i % colors.length]!(`[${i + 1}]`));
  o.models.forEach((m, i) => say(`${labels[i]} ${m}`));
  say();

  let results: Outcome[];
  try {
    results = await Promise.all(o.models.map((m, i) => runOne(o, m, controller.signal, labels[i]!)));
  } finally {
    process.off("SIGINT", onSigint);
  }

  const out = (s = "") => process.stdout.write(s + "\n");
  out();
  out(table([
    ["#", "model", "result", "steps", "tools", "tokens in/out", "time", "files changed"],
    ...results.map((r, i) => [
      String(i + 1),
      r.spec,
      r.status === "error" ? "error" : r.status,
      String(r.steps),
      String(r.toolCalls),
      `${fmtK(r.inputTokens)} / ${fmtK(r.outputTokens)}`,
      `${(r.ms / 1000).toFixed(1)}s`,
      r.diffStat ? (r.diffStat.split("\n").pop() ?? "").trim().replace(/ changed.*/, "") : "0 files",
    ]),
  ]));

  results.forEach((r, i) => {
    out();
    out(pc.bold(`${labels[i]} ${r.spec}`));
    if (r.error) out(pc.red(`Error: ${r.error}`));
    if (r.text) out(r.text);
    else if (!r.error) out(pc.dim(r.status === "step cap" ? "(no final message: stopped at the step cap; raise it with --max-steps)" : "(no final message)"));
    if (r.diffStat) out(pc.dim(r.diffStat));
    if (r.diff) out(r.diff);
    if (r.dir) out(pc.dim(`copy: ${r.dir}`));
  });
  if (!o.diff && results.some((r) => r.diffStat)) out(pc.dim("\nRun with --diff to print full diffs, or cd into a copy and run git diff HEAD."));
}
