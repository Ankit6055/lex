// Live side-by-side panes for `lex compare`: one per model, each with a running scoreboard
// (status, step, tokens, speed, cost, time) and its latest tool activity.
import { Screen } from "./screen.ts";
import { t, bold, bar, spinnerFrame } from "./theme.ts";
import { pad, truncate } from "./text.ts";
import { formatCost } from "../pricing.ts";

export type RaceStatus = "starting" | "running" | "checking" | "done" | "step cap" | "error" | "aborted";

export interface Lane {
  spec: string;
  status: RaceStatus;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  tps?: number;
  cost?: number;
  start: number;
  end?: number;
  check?: "pass" | "fail";
  activity: string[];
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const short = (spec: string) => spec.slice(spec.lastIndexOf(spec.includes("/") ? "/" : ":") + 1);

function statusText(l: Lane, tick: number): string {
  switch (l.status) {
    case "starting": return `${spinnerFrame(tick)} ${t.mist("starting")}`;
    case "running": return `${spinnerFrame(tick)} ${t.ink("working")}`;
    case "checking": return `${spinnerFrame(tick)} ${t.cyan("checking")}`;
    case "done": return l.check === "fail" ? t.coral("✗ check failed") : l.check === "pass" ? t.aqua("✓ passed") : t.aqua("✓ done");
    case "step cap": return t.gold("◼ step cap");
    case "error": return t.coral("✗ error");
    case "aborted": return t.gold("◼ stopped");
  }
}

export function laneStats(l: Lane): string {
  const secs = ((l.end ?? Date.now()) - l.start) / 1000;
  // Most important first, so narrow panes truncate the least useful numbers.
  return [`${secs.toFixed(1)}s`, formatCost(l.cost), `step ${l.steps}`, `${fmtK(l.inputTokens)}↑ ${fmtK(l.outputTokens)}↓`, ...(l.tps ? [`${Math.round(l.tps)} tok/s`] : [])].join(" · ");
}

/** The panes as lines (used live and for the final snapshot). */
export function renderPanes(lanes: Lane[], cols: number, height: number, tick = 0, leader = -1): string[] {
  const n = lanes.length;
  const sep = t.hair(" │ ");
  const w = Math.max(18, Math.floor((cols - 1 - (n - 1) * 3) / n));
  const cells = lanes.map((l, i) => {
    const head = `${i === leader ? bar(0, 1) : " "}${bold(t.ink(truncate(short(l.spec), w - 16)))}`;
    const rows = [
      pad(head, w - 14) + pad(statusText(l, tick), 14),
      t.shade(truncate(laneStats(l), w)),
      t.hair("─".repeat(w)),
      ...l.activity.slice(-height).map((a) => truncate(a, w)),
    ];
    while (rows.length < height + 3) rows.push("");
    return rows.map((r) => pad(r, w));
  });
  return cells[0]!.map((_, r) => cells.map((c) => c[r]).join(sep));
}

export class RaceView {
  private screen = new Screen();
  private tick = 0;
  private timer?: ReturnType<typeof setInterval>;
  constructor(public lanes: Lane[]) {}

  private height(): number {
    const rows = process.stdout.rows || 30;
    return Math.max(4, Math.min(14, rows - 8));
  }

  start(onStop: () => void): void {
    this.screen.start();
    this.screen.pushKeys((_s, key) => {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) onStop();
    });
    this.screen.setView(() => ({
      lines: [
        ...renderPanes(this.lanes, this.screen.cols, this.height(), this.tick),
        "",
        t.shade(`  each model works in its own temp copy · esc to stop`),
      ],
    }));
    this.timer = setInterval(() => { this.tick++; this.screen.render(); }, 120);
  }

  render(): void {
    this.screen.render();
  }

  /** Stop live updates and return a static snapshot of the final panes (leader highlighted). */
  stop(leader: number): string[] {
    clearInterval(this.timer);
    this.screen.stop();
    return renderPanes(this.lanes, this.screen.cols, this.height(), 0, leader);
  }
}
