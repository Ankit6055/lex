// The interactive terminal app: start screen, composer, live activity, dialogs and commands.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import type { ApprovalMode, IO } from "../types.ts";
import type { ReplOptions } from "../repl.ts";
import { Screen } from "./screen.ts";
import { Composer, type MenuItem } from "./composer.ts";
import { ListPanel, InputPanel, ApprovalPanel, type Panel, type Item } from "./panels.ts";
import { createTranscript, type Activity } from "./transcript.ts";
import { t, bold, wordmark, spinnerFrame } from "./theme.ts";
import { pad, truncate, width, wrapPlain } from "./text.ts";
import { createApprover } from "../approval.ts";
import { createSession, type Session } from "../session.ts";
import { ModelError, NO_KEY_MESSAGE, listAvailable, suggestedModels } from "../models.ts";
import { configDir, login, redact, saveConfig } from "../auth.ts";
import { loadContext } from "../context.ts";
import { formatFooter } from "../render.ts";
import { getTodoList, renderTodos } from "../tools/todo.ts";
import { runCompare } from "../compare.ts";
import { capTail } from "../util/truncate.ts";

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const tilde = (p: string) => (p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p);
const shortModel = (spec: string) => spec.slice(spec.lastIndexOf(spec.includes("/") ? "/" : ":") + 1);

const MODE_CYCLE: ApprovalMode[] = ["ask", "edits", "readonly"];

function modeLabel(mode: ApprovalMode): string {
  switch (mode) {
    case "edits": return t.gold("⏵⏵ accept edits on");
    case "readonly": return t.cyan("⏸ plan mode on");
    case "yolo": return t.coral("⏵⏵ bypass permissions on");
    default: return "";
  }
}

// ─── Small persistence helpers ────────────────────────────────────────────────────────────────────

const historyFile = () => path.join(configDir(), "history");

function loadHistory(): string[] {
  try {
    return readFileSync(historyFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string).slice(-500);
  } catch {
    return [];
  }
}

function saveHistory(entry: string): void {
  try {
    mkdirSync(configDir(), { recursive: true });
    appendFileSync(historyFile(), JSON.stringify(entry) + "\n");
  } catch { /* history is a convenience */ }
}

function listFiles(root: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter(Boolean).slice(0, 20000);
  } catch {
    return [];
  }
}

// ─── Model lists for the pickers ──────────────────────────────────────────────────────────────────

async function modelItems(): Promise<Item<string>[]> {
  const [suggested, all] = await Promise.all([suggestedModels(), listAvailable()]);
  const seen = new Set<string>();
  const items: Item<string>[] = [];
  for (const m of suggested) if (!seen.has(m.spec)) { seen.add(m.spec); items.push({ label: m.spec, value: m.spec, hint: "recommended" }); }
  for (const m of all) if (!seen.has(m.spec)) { seen.add(m.spec); items.push({ label: m.spec, value: m.spec, hint: `via ${m.provider}` }); }
  return items;
}

/** Standalone multi-select (for `lex compare` without --models). */
export async function pickModels(): Promise<string[] | null> {
  const screen = new Screen();
  const items = await modelItems();
  screen.start();
  try {
    return await new Promise<string[] | null>((resolve) => {
      const panel = new ListPanel<string>({ title: "Compare models", subtitle: "pick 2 or more", items, multi: true, search: true, minSelected: 2 }, (v) => resolve(v as string[] | null));
      screen.pushKeys((s, k) => { panel.onKey(s, k); screen.render(); });
      screen.setView(() => panel.render(screen.cols));
    });
  } finally {
    screen.stop();
  }
}

// ─── The app ──────────────────────────────────────────────────────────────────────────────────────

export async function runTui(o: ReplOptions): Promise<void> {
  const screen = new Screen();
  screen.start();

  let panel: Panel | null = null;
  let busy = false;
  let controller: AbortController | null = null;
  let activity: Activity | null = null;
  let tick = 0;
  let statusMsg = "";
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let showHelp = false;
  let exitArmed = false;
  let files: string[] | null = null;
  let shellContext = "";
  const queue: string[] = [];
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));

  const flash = (msg: string, ms = 2500) => {
    statusMsg = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { statusMsg = ""; exitArmed = false; screen.render(); }, ms);
    screen.render();
  };

  /** Show a panel until it resolves. */
  function open<T>(make: (done: (v: T) => void) => Panel): Promise<T> {
    return new Promise<T>((resolve) => {
      let pop = () => {};
      const p = make((v) => { pop(); panel = null; screen.render(); resolve(v); });
      panel = p;
      pop = screen.pushKeys((s, k) => { p.onKey(s, k); screen.render(); });
      screen.render();
    });
  }

  const OTHER = "\u0000other";
  const io: IO = {
    async confirm(question) {
      const v = await open<string | null>((done) => new ListPanel({ title: question.replace(/\s*\[y\/n\]\s*$/i, ""), items: [{ label: "Yes", value: "y" }, { label: "No", value: "n" }] }, (x) => done(x as string | null)));
      return v === "y" ? "y" : "n";
    },
    async choose(question, options) {
      const items: Item<string>[] = [...options.map((x) => ({ label: x, value: x })), { label: "Type something else…", value: OTHER }];
      const v = await open<string | null>((done) => new ListPanel({ title: question, items }, (x) => done(x as string | null)));
      if (v === OTHER) return (await open<string | null>((done) => new InputPanel({ title: question }, done))) ?? "";
      return v ?? "";
    },
    prompt: (label) => open<string | null>((done) => new InputPanel({ title: label.trim() }, done)),
    async secret(label) {
      return (await open<string | null>((done) => new InputPanel({ title: label.trim(), mask: true }, done))) ?? "";
    },
    withPaused: (fn) => fn(),
    info: (msg) => screen.print(t.shade(`  ${msg}`)),
    async approve(req) {
      const answer = await open<"y" | "a" | "n">((done) => new ApprovalPanel(req, done));
      if (answer === "n") controller?.abort(); // like "No, and tell lex what to do differently": stop and hand back
      return answer;
    },
  };

  // Session (offer login on a first run with no key).
  const approver = createApprover(io, o.mode);
  const makeSession = () => createSession({ root: o.root, io, approver, model: o.model, maxSteps: o.maxSteps });
  let session: Session;
  try {
    session = await makeSession();
  } catch (e) {
    if (!(e instanceof ModelError && e.message === NO_KEY_MESSAGE)) { screen.stop(); throw e; }
    screen.print(t.gold(NO_KEY_MESSAGE));
    if ((await io.confirm("Set up a key now?")) === "n") { screen.stop(); throw e; }
    await login(io);
    session = await makeSession();
  }
  const modes = o.mode === "yolo" ? [...MODE_CYCLE, "yolo" as const] : MODE_CYCLE;

  // ── Start screen ──
  await printBanner(screen, session);

  // ── Composer ──
  const commands = buildCommands();
  const composer = new Composer({
    submit: (text) => {
      saveHistory(text);
      if (busy) {
        if (text.startsWith("/") || text.startsWith("!")) { flash("Wait for lex to finish, or press esc to interrupt"); return; }
        queue.push(text);
        screen.render();
        return;
      }
      void handle(text);
    },
    suggest: (before) => {
      const slash = before.match(/^\/(\S*)$/);
      if (slash) {
        const q = slash[1]!.toLowerCase();
        const items: MenuItem[] = commands
          .filter((c) => c.name.startsWith(q) || (q.length > 1 && c.name.includes(q)))
          .map((c) => ({ label: `/${c.name}${c.args ? ` ${c.args}` : ""}`, hint: c.desc, insert: c.needsArg ? `/${c.name} ` : `/${c.name}`, run: !c.needsArg }));
        return { items, from: 0 };
      }
      const at = before.match(/(?:^|\s)@([^\s@]*)$/);
      if (at) {
        files ??= listFiles(session.root);
        const q = at[1]!.toLowerCase();
        const ranked = files
          .filter((f) => f.toLowerCase().includes(q))
          .sort((a, b) => Number(!path.basename(a).toLowerCase().startsWith(q)) - Number(!path.basename(b).toLowerCase().startsWith(q)) || a.length - b.length)
          .slice(0, 50)
          .map((f) => ({ label: `@${f}`, insert: `@${f} ` }));
        return { items: ranked, from: before.length - at[1]!.length - 1 };
      }
      return null;
    },
  }, loadHistory());

  // ── View ──
  const placeholder = () =>
    busy ? (queue.length ? "Press up to edit queued messages" : "Type to queue a message for when lex is done")
      : session.messages.length ? "Reply, or / for commands" : 'Try "explain this codebase" or "fix the failing test"';

  function statusLine(cols: number): string {
    const mode = modeLabel(session.approver.mode);
    let left = statusMsg ? t.gold(statusMsg)
      : mode ? `${mode} ${t.shade("(shift+tab to cycle)")}` : t.shade("? for shortcuts");
    if (busy && !statusMsg) left += t.shade(" · esc to interrupt");
    const ctx = activity?.ctxTokens ? ` · ${fmtK(activity.ctxTokens)} ctx` : "";
    const right = t.shade(`${shortModel(session.model.spec)}${ctx} · ${path.basename(session.root)}`);
    const gap = cols - 3 - width(left) - width(right);
    return gap >= 2 ? `  ${left}${" ".repeat(gap)}${right}` : `  ${left}`;
  }

  const HELP_GRID = [
    ["/ for commands", "@ for files", "# to remember"],
    ["! for shell commands", "shift+tab cycle modes", "ctrl+l pick model"],
    ["\\⏎ or ⌥⏎ new line", "ctrl+p next model", "ctrl+g open in $EDITOR"],
    ["esc interrupt", "ctrl+c clear · twice to exit", "↑ history · edit queued"],
  ];

  screen.setView(() => {
    const cols = screen.cols;
    const lines: string[] = [];
    if (busy && activity) {
      const secs = Math.floor((Date.now() - activity.startedAt) / 1000);
      const stats = [`${secs}s`, `↓ ${fmtK(activity.outTokens)} tokens`, ...(activity.tps ? [`${Math.round(activity.tps)} tok/s`] : [])].join(" · ");
      lines.push(`${spinnerFrame(tick)} ${t.ink(`${activity.label}…`)} ${t.shade(`(${stats})`)}`, "");
    }
    for (const m of queue) lines.push(`${t.mist("  ↳")} ${t.mist(truncate(m.replace(/\n/g, " ⏎ "), cols - 8))}`);
    if (panel) {
      const v = panel.render(cols);
      return { lines: [...lines, ...v.lines], cursor: v.cursor ? { row: lines.length + v.cursor.row, col: v.cursor.col } : undefined };
    }
    const c = composer.render(cols, placeholder());
    const offset = lines.length;
    lines.push(...c.lines);
    if (composer.menu) lines.push(...composer.renderMenu(cols));
    else if (showHelp) {
      const colW = Math.floor((cols - 4) / 3);
      for (const row of HELP_GRID) lines.push("  " + row.map((cell) => pad(t.mist(cell), colW)).join(""));
    } else lines.push(statusLine(cols));
    return { lines, cursor: { row: offset + c.cursor.row, col: c.cursor.col } };
  });

  // ── Turns ──
  async function runTurn(text: string): Promise<void> {
    busy = true;
    controller = new AbortController();
    const transcript = createTranscript(screen);
    activity = transcript.activity;
    activity.startedAt = Date.now();
    printUser(text);
    const input = shellContext ? `${shellContext}\n\n${text}` : text;
    shellContext = "";
    const spin = setInterval(() => { tick++; screen.render(); }, 120);
    try {
      const turn = await session.turn(input, {
        signal: controller.signal,
        onChunk: (c) => { transcript.onChunk(c); screen.render(); },
      });
      transcript.endText();
      if (!turn.aborted) screen.print(t.shade(`  ${formatFooter(turn.usage, session.model.spec)}`));
    } catch (e) {
      transcript.endText();
      screen.print(t.coral(`  ✗ ${redact(e instanceof Error ? e.message : String(e))}`) + "\n" + t.shade("    The turn was rolled back. Retry, or switch models with ctrl+l."));
    } finally {
      clearInterval(spin);
      busy = false;
      controller = null;
      files = null; // the agent may have created files
      screen.render();
    }
    if (queue.length) await handle(queue.splice(0).join("\n"));
  }

  function printUser(text: string): void {
    const rows = wrapPlain(text, screen.cols - 4);
    screen.print("\n" + rows.map((r, i) => `${i === 0 ? t.mist("❯") : " "} ${t.mist(r.text)}`).join("\n") + "\n");
  }

  async function runShell(cmd: string): Promise<void> {
    if (!cmd) return;
    printUser(`!${cmd}`);
    busy = true;
    activity = { label: `Running ${truncate(cmd, 40)}`, startedAt: Date.now(), outTokens: 0 };
    const spin = setInterval(() => { tick++; screen.render(); }, 120);
    const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(cmd, { shell: true, cwd: session.root, env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat" }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
      child.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, out: e.message }); });
    });
    clearInterval(spin);
    busy = false;
    const body = result.out.trimEnd().split("\n");
    const shown = body.slice(-20).map((l) => `    ${t.shade(truncate(l, screen.cols - 6))}`);
    screen.print([`  ${t.hair("└")} ${result.code === 0 ? t.mist("exit 0") : t.coral(`exit ${result.code}`)}${body.length > 20 ? t.shade(` · last 20 of ${body.length} lines`) : ""}`, ...shown].join("\n"));
    shellContext += `${shellContext ? "\n\n" : ""}I ran this in my terminal (exit ${result.code}):\n$ ${cmd}\n${capTail(result.out.trimEnd(), 4000)}`;
    flash("Shell output will be shared with lex in your next message", 4000);
  }

  async function remember(fact: string): Promise<void> {
    if (!fact) return flash("Usage: # <fact to remember>");
    const tool = session.tools.remember as { execute?: (i: { fact: string }, o: unknown) => Promise<string> } | undefined;
    const out = await tool?.execute?.({ fact }, { toolCallId: "user", messages: [] });
    screen.print(`  ${t.aqua("●")} ${t.mist(out ?? "Memory isn't available")}`);
  }

  async function handle(text: string): Promise<void> {
    if (text.startsWith("/")) {
      const [name = "", ...rest] = text.slice(1).split(/\s+/);
      const cmd = commands.find((c) => c.name === name.toLowerCase() || c.aliases?.includes(name.toLowerCase()));
      if (!cmd) return flash(`Unknown command /${name}. Type / to see commands.`);
      try { await cmd.run(rest.join(" ").trim()); }
      catch (e) { screen.print(t.coral(`  ✗ ${redact(e instanceof Error ? e.message : String(e))}`)); }
      return;
    }
    if (text.startsWith("!")) return runShell(text.slice(1).trim());
    if (text.startsWith("#")) return remember(text.slice(1).trim());
    return runTurn(text);
  }

  // ── Pickers ──
  async function pickModel(): Promise<void> {
    flash("Loading models…", 10_000);
    const items = await modelItems();
    statusMsg = "";
    const v = await open<string | null>((done) => new ListPanel({ title: "Select model", subtitle: `${items.length} models · history is kept`, items, search: true, current: session.model.spec }, (x) => done(x as string | null)));
    if (v && v !== session.model.spec) await switchModel(v);
  }

  async function switchModel(spec: string): Promise<void> {
    const m = await session.setModel(spec);
    await saveConfig({ defaultModel: m.spec }); // remembered for the next launch
    const note = busy ? " · takes over at the next step" : session.messages.length ? ` · conversation continues (${session.messages.length} messages)` : "";
    screen.print(`  ${t.aqua(busy ? "⇄" : "●")} ${t.mist("Model")} ${t.ink(m.spec)}${t.shade(` · saved as your default${note}`)}`);
  }

  async function cycleModel(): Promise<void> {
    const list = (await suggestedModels()).map((m) => m.spec);
    if (!list.length) return;
    const next = list[(list.indexOf(session.model.spec) + 1) % list.length]!;
    await switchModel(next);
  }

  function cycleMode(): void {
    const i = modes.indexOf(session.approver.mode);
    session.approver.setMode(modes[(i + 1) % modes.length]!);
    screen.render();
  }

  async function compare(arg: string): Promise<void> {
    flash("Loading models…", 10_000);
    const items = await modelItems();
    statusMsg = "";
    const picked = await open<string[] | null>((done) => new ListPanel({ title: "Compare models", subtitle: "same task, separate temp copies", items, multi: true, search: true, minSelected: 2, preselected: [session.model.spec] }, (x) => done(x as string[] | null)));
    if (!picked) return;
    const task = arg || (await open<string | null>((done) => new InputPanel({ title: "Task for every model", placeholder: "add input validation to createUser" }, done)));
    if (!task?.trim()) return;
    await screen.suspend(() => runCompare({ root: session.root, models: picked, task, maxSteps: o.maxSteps }));
  }

  async function externalEditor(): Promise<void> {
    const dir = mkdtempSync(path.join(tmpdir(), "lex-edit-"));
    const file = path.join(dir, "message.md");
    writeFileSync(file, composer.text);
    const editor = process.env.VISUAL || process.env.EDITOR || "nano";
    await screen.suspend(async () => { spawnSync(editor, [file], { stdio: "inherit", shell: true }); });
    try { composer.setText(readFileSync(file, "utf8").replace(/\s+$/, "")); } catch { /* keep text */ }
    rmSync(dir, { recursive: true, force: true });
    screen.render();
  }

  function buildCommands() {
    type Cmd = { name: string; desc: string; args?: string; needsArg?: boolean; aliases?: string[]; run: (arg: string) => Promise<void> | void };
    const list: Cmd[] = [
      { name: "model", args: "[spec]", desc: "Pick a model (history is kept)", run: (a) => (a ? switchModel(a) : pickModel()) },
      { name: "compare", args: "[task]", desc: "Run one task on several models side by side", run: compare },
      { name: "plan", desc: "Toggle plan mode (read-only: investigate and propose)", run: () => { session.approver.setMode(session.approver.mode === "readonly" ? "ask" : "readonly"); screen.render(); } },
      { name: "edits", desc: "Toggle accept-edits mode (still asks for commands)", run: () => { session.approver.setMode(session.approver.mode === "edits" ? "ask" : "edits"); screen.render(); } },
      { name: "clear", desc: "Start a fresh conversation", aliases: ["new"], run: () => { session.clear(); screen.print(t.shade("  Conversation cleared.")); } },
      { name: "memory", desc: "Show what lex remembers about this project", run: async () => {
        const mem = await readFile(session.memoryPath, "utf8").then((s) => s.trim(), () => "");
        screen.print(mem ? mem.split("\n").map((l) => `  ${t.mist(l)}`).join("\n") : t.shade("  Nothing yet. Type # followed by a fact to save one."));
      } },
      { name: "remember", args: "<fact>", needsArg: true, desc: "Save a fact for future sessions (same as # fact)", run: remember },
      { name: "todo", desc: "Show the current todo list", run: () => {
        const items = session.tools.todo ? getTodoList(session.tools.todo) : [];
        screen.print(items.length ? renderTodos(items).split("\n").map((l) => `  ${l}`).join("\n") : t.shade("  No todos."));
      } },
      { name: "usage", desc: "Tokens, speed and time for this session", run: () => {
        const u = session.totals;
        screen.print(t.mist(`  ${u.turns} turns · ${u.toolCalls} tool calls · ${formatFooter(u, session.model.spec)}`));
      } },
      { name: "yolo", desc: "Toggle bypass mode: run everything without asking", run: () => { session.approver.setMode(session.approver.mode === "yolo" ? "ask" : "yolo"); screen.render(); } },
      { name: "login", desc: "Save an API key", run: () => login(io) },
      { name: "help", desc: "Commands and shortcuts", run: () => {
        const w = Math.max(...list.map((c) => c.name.length + (c.args?.length ?? 0))) + 4;
        screen.print(["", ...list.map((c) => `  ${pad(t.ink(`/${c.name}`) + (c.args ? t.shade(` ${c.args}`) : ""), w)} ${t.mist(c.desc)}`), "", ...HELP_GRID.map((r) => `  ${t.shade(r.join("  ·  "))}`)].join("\n"));
      } },
      { name: "exit", desc: "Quit lex", aliases: ["quit"], run: () => finish() },
    ];
    return list;
  }

  // ── Keys ──
  screen.pushKeys((str, key) => {
    if (key.ctrl && key.name === "c") {
      if (composer.text) composer.clear();
      else if (busy) controller?.abort();
      else if (exitArmed) return finish();
      else { exitArmed = true; flash("Press ctrl+c again to exit", 2000); }
      return screen.render();
    }
    if (key.name === "escape" && !composer.menu) {
      if (busy) controller?.abort();
      else if (showHelp) showHelp = false;
      return screen.render();
    }
    if (key.ctrl && key.name === "d" && !composer.text && !busy) return finish();
    if (key.name === "tab" && key.shift) return cycleMode();
    if (key.ctrl && key.name === "l") return void pickModel().catch((e) => flash(redact(String(e?.message ?? e))));
    if (key.ctrl && key.name === "p") return void cycleModel().catch((e) => flash(redact(String(e?.message ?? e))));
    if (key.ctrl && key.name === "g") return void externalEditor();
    if (queue.length && ((key.name === "up" && !composer.text) || (key.meta && key.name === "up"))) {
      composer.setText(queue.splice(0).join("\n"));
      return screen.render();
    }
    if (str === "?" && !composer.text && !key.ctrl && !key.meta) { showHelp = !showHelp; return screen.render(); }
    showHelp = false;
    composer.onKey(str, key);
    screen.render();
  });

  await finished;
  (controller as AbortController | null)?.abort();
  screen.stop();
  const u = session.totals;
  if (u.turns) process.stdout.write(t.shade(`${u.turns} turns · ${formatFooter(u, session.model.spec)}\n`));
}

async function printBanner(screen: Screen, session: Session): Promise<void> {
  const ctx = await loadContext(session.root);
  const mem = await readFile(session.memoryPath, "utf8").then((s) => s.split("\n").filter((l) => l.startsWith("- ")).length, () => 0);
  const cols = screen.cols;
  const W = Math.min(cols - 2, 76);
  const inner = W - 2;
  const row = (s = "") => t.hair("│") + pad(s, inner) + t.hair("│");
  const out: string[] = [t.hair("┌" + "─".repeat(inner) + "┐"), row()];
  if (inner >= 34) for (const l of wordmark()) out.push(row("   " + l));
  else out.push(row("   " + bold(t.ink("lex"))));
  out.push(row(), row(`   ${t.mist("a coding agent you can read in an afternoon")}  ${t.shade(`v${pkg.version}`)}`), row());
  const half = Math.floor(inner / 2);
  const cells = (a: string, b: string) => t.hair("│") + pad(` ${a}`, half) + t.hair("│") + pad(` ${b}`, inner - half - 1) + t.hair("│");
  out.push(t.hair("├" + "─".repeat(half) + "┬" + "─".repeat(inner - half - 1) + "┤"));
  const [provider, ...idParts] = session.model.spec.split(":");
  const instr = ctx.projectInstructions ? path.relative(session.root, ctx.projectInstructions.file) || ctx.projectInstructions.file : "no AGENTS.md";
  out.push(cells(t.shade("MODEL"), t.shade("PROJECT")));
  out.push(cells(t.ink(idParts.join(":")), t.ink(`${tilde(session.root)}${ctx.gitBranch ? t.mist(` (${ctx.gitBranch})`) : ""}`)));
  out.push(cells(t.mist(`via ${provider}`), t.mist(`${instr} · ${mem} ${mem === 1 ? "memory" : "memories"}${ctx.skills?.length ? ` · ${ctx.skills.length} skills` : ""}`)));
  out.push(t.hair("└" + "─".repeat(half) + "┴" + "─".repeat(inner - half - 1) + "┘"));
  out.push(`  ${t.shade("/ commands · @ files · shift+tab modes · ctrl+l models · ? shortcuts")}`, "");
  screen.print(out.join("\n"));
}
