// `lex compare`: the same task on N models, each in its own throwaway copy of the project.
import { cp, mkdtemp, mkdir, appendFile, symlink, stat, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import pc from "picocolors";
import { t } from "./ui/theme.ts";
import type { IO } from "./types.ts";
import { createApprover } from "./approval.ts";
import { createSession } from "./session.ts";
import { callLabel, resultSuffix } from "./render.ts";
import { redact } from "./auth.ts";
import { resolveModel } from "./models.ts";
import { loadPrices, estimateCost, formatCost, priceKey, type Price } from "./pricing.ts";
import { toolTitle, toolOutcome } from "./ui/transcript.ts";
import type { Lane } from "./ui/race.ts";
import { capTail } from "./util/truncate.ts";

const run = promisify(execFile);

export interface CompareOptions {
  root: string;
  models: string[];
  task: string;
  diff?: boolean;
  maxSteps?: number;
  /** Command run in each copy afterwards to decide pass/fail (default: `npm test` if the project has a test script). */
  check?: string;
}

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
  cost?: number;
  check?: "pass" | "fail";
  checkOutput?: string;
}

/** `npm test` when package.json defines a real test script; otherwise no automatic check. */
async function detectCheck(root: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const test = pkg.scripts?.test;
    return test && !/no test specified/.test(test) ? "npm test" : undefined;
  } catch {
    return undefined;
  }
}

async function runCheck(dir: string, command: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile("sh", ["-c", command], { cwd: dir, timeout: 120_000, maxBuffer: 16 << 20, env: { ...process.env, CI: "1" } }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: capTail(`${stdout}${stderr}`.trim(), 2000) }));
  });
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

async function runOne(
  o: CompareOptions,
  spec: string,
  signal: AbortSignal,
  lane: Lane,
  ctx: { check?: string; log?: (line: string) => void; changed: () => void },
): Promise<Outcome> {
  const out: Outcome = { spec, steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, ms: 0, status: "error", text: "", diffStat: "", diff: "" };
  const calls = new Map<string, { name: string; input: unknown }>();
  let cached = 0;
  let prices = new Map<string, Price>();
  try {
    out.spec = lane.spec = (await resolveModel(spec)).spec; // validate the spec before copying anything
    const key = priceKey(out.spec);
    if (key && key !== "local") prices = await loadPrices(); // only fetch the catalog for priceable models
    out.dir = await makeCopy(o.root, out.spec);
    lane.status = "running";
    ctx.changed();
    const copy = await createSession({ root: out.dir, io: silentIO, approver: createApprover(silentIO, "yolo"), model: out.spec, maxSteps: o.maxSteps, checkpoints: false });
    const turn = await copy.turn(o.task, {
      signal,
      onChunk: (c) => {
        if (c.type === "tool-call") calls.set(c.toolCallId, { name: c.toolName, input: c.input });
        else if (c.type === "tool-result") {
          const call = calls.get(c.toolCallId);
          const name = call?.name ?? c.toolName, input = call?.input ?? c.input;
          const title = toolTitle(name, input), res = toolOutcome(name, input, c.output);
          const dot = res.status === "ok" ? t.aqua("●") : res.status === "denied" ? t.gold("●") : t.coral("●");
          lane.activity.push(`${dot} ${t.ink(title.name)}${t.mist(title.arg ? `(${title.arg})` : "")}`);
          if (res.lines[0]) lane.activity.push(`  ${t.hair("└")} ${t.mist(res.lines[0])}`);
          ctx.log?.(`${pc.dim(`● ${callLabel(name, input)}`)}${resultSuffix(name, input, c.output)}`);
        } else if (c.type === "finish-step") {
          lane.steps++;
          lane.inputTokens += c.usage.inputTokens ?? 0;
          lane.outputTokens += c.usage.outputTokens ?? 0;
          cached += c.usage.inputTokenDetails?.cacheReadTokens ?? 0;
          const n = c.usage.outputTokens ?? 0, tps = c.performance?.outputTokensPerSecond;
          if (n >= 20 && tps && (n / tps) * 1000 >= 250) lane.tps = tps;
          lane.cost = estimateCost(prices, out.spec, { inputTokens: lane.inputTokens, outputTokens: lane.outputTokens, cachedInputTokens: cached });
        } else return;
        ctx.changed();
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
  out.ms = Date.now() - lane.start;
  out.cost = estimateCost(prices, out.spec, { inputTokens: out.inputTokens, outputTokens: out.outputTokens, cachedInputTokens: cached });
  if (out.dir && ctx.check && out.status !== "error" && out.status !== "aborted") {
    lane.status = "checking";
    ctx.changed();
    const r = await runCheck(out.dir, ctx.check);
    out.check = lane.check = r.ok ? "pass" : "fail";
    out.checkOutput = r.output;
  }
  if (out.dir) {
    try {
      await git(out.dir, "add", "-A");
      out.diffStat = (await git(out.dir, "diff", "--cached", "--stat")).stdout.trim();
      if (o.diff) out.diff = (await git(out.dir, "diff", "--cached", "--color=always")).stdout.trim();
    } catch { /* leave empty */ }
  }
  lane.status = out.status;
  lane.end = Date.now();
  ctx.changed();
  ctx.log?.(`${out.status === "done" ? pc.green("finished") : pc.yellow(out.status)}${out.check ? ` · check ${out.check === "pass" ? pc.green("passed") : pc.red("failed")}` : ""}${out.error ? pc.red(` ${out.error.split("\n")[0]}`) : ""}`);
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
  const check = o.check ?? (await detectCheck(o.root));
  const live = !!(process.stdin.isTTY && process.stdout.isTTY && !process.env.LEX_PLAIN);
  say(pc.bold(`lex compare · ${o.models.length} models · "${o.task}"`));
  say(pc.yellow("Each model runs unattended (no approval prompts) in its own temp copy of this project. Your files are not touched."));
  if (check) say(pc.dim(`Pass/fail: \`${check}\` runs in each copy afterwards (change with --check).`));
  say();

  const controller = new AbortController();
  const stop = () => (controller.signal.aborted ? process.exit(130) : controller.abort());
  process.on("SIGINT", stop);

  const lanes: Lane[] = o.models.map((spec) => ({ spec, status: "starting", steps: 0, inputTokens: 0, outputTokens: 0, start: Date.now(), activity: [] }));
  const colors = [pc.cyan, pc.magenta, pc.yellow, pc.green, pc.blue];
  const labels = o.models.map((m, i) => colors[i % colors.length]!(`[${i + 1}]`));

  let view: import("./ui/race.ts").RaceView | undefined;
  if (live) {
    const { RaceView } = await import("./ui/race.ts");
    view = new RaceView(lanes);
    view.start(stop);
  } else {
    o.models.forEach((m, i) => say(`${labels[i]} ${m}`));
    say();
  }

  let results: Outcome[];
  try {
    results = await Promise.all(o.models.map((m, i) => runOne(o, m, controller.signal, lanes[i]!, {
      check,
      log: live ? undefined : (line) => say(`${labels[i]} ${line}`),
      changed: () => view?.render(),
    })));
  } finally {
    process.off("SIGINT", stop);
  }

  // Winner: fastest among the runs that passed the check (or finished, without a check); also the cheapest.
  const ok = results.map((r, i) => ({ r, i })).filter(({ r }) => r.status === "done" && (!check || r.check === "pass"));
  const fastest = ok.length ? ok.reduce((a, b) => (b.r.ms < a.r.ms ? b : a)) : undefined;
  const priced = ok.filter(({ r }) => r.cost !== undefined);
  const cheapest = priced.length ? priced.reduce((a, b) => (b.r.cost! < a.r.cost! ? b : a)) : undefined;

  const out = (s = "") => process.stdout.write(s + "\n");
  if (view) out(view.stop(fastest?.i ?? -1).join("\n"));
  out();
  out(table([
    ["#", "model", "result", "check", "steps", "tools", "tokens in/out", "cost", "time", "files changed"],
    ...results.map((r, i) => [
      String(i + 1),
      r.spec,
      r.status === "error" ? "error" : r.status,
      r.check ?? (check ? "—" : "n/a"),
      String(r.steps),
      String(r.toolCalls),
      `${fmtK(r.inputTokens)} / ${fmtK(r.outputTokens)}`,
      formatCost(r.cost),
      `${(r.ms / 1000).toFixed(1)}s`,
      r.diffStat ? (r.diffStat.split("\n").pop() ?? "").trim().replace(/ changed.*/, "") : "0 files",
    ]),
  ]));
  if (fastest) {
    const what = check ? "passing" : "finished";
    const parts = [`fastest ${what}: ${fastest.r.spec} (${(fastest.r.ms / 1000).toFixed(1)}s)`];
    if (cheapest) parts.push(`cheapest ${what}: ${cheapest.r.spec} (${formatCost(cheapest.r.cost)})`);
    out(pc.bold(`\n◆ ${parts.join(" · ")}`));
  } else if (check) {
    out(pc.yellow(`\nNo model passed \`${check}\`.`));
  }

  results.forEach((r, i) => {
    out();
    out(pc.bold(`${labels[i]} ${r.spec}`));
    if (r.error) out(pc.red(`Error: ${r.error}`));
    if (r.text) out(r.text);
    else if (!r.error) out(pc.dim(r.status === "step cap" ? "(no final message: stopped at the step cap; raise it with --max-steps)" : "(no final message)"));
    if (r.check === "fail" && r.checkOutput) out(pc.dim(`check \`${check}\` failed:\n${r.checkOutput.split("\n").slice(-8).join("\n")}`));
    if (r.diffStat) out(pc.dim(r.diffStat));
    if (r.diff) out(r.diff);
    if (r.dir) out(pc.dim(`copy: ${r.dir}`));
  });
  if (!o.diff && results.some((r) => r.diffStat)) out(pc.dim("\nRun with --diff to print full diffs, or cd into a copy and run git diff HEAD."));
}
