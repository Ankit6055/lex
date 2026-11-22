// Stream chunks -> terminal. Model text goes to stdout; tool lines, spinner and footer go to stderr.
import pc from "picocolors";
import type { Chunk } from "./agent.ts";
import type { TurnUsage } from "./types.ts";

export interface Spinner {
  start(label: string): void;
  stop(): void;
}

const noSpinner: Spinner = { start() {}, stop() {} };

const quote = (s: unknown, n = 40) => {
  const str = String(s ?? "").replace(/\s+/g, " ").trim();
  return `"${str.length > n ? str.slice(0, n - 1) + "…" : str}"`;
};
const lineCount = (s: unknown) => (typeof s === "string" && s.length ? s.split("\n").length : 0);

/** One-line label for a tool call, before it runs (used for the spinner). */
function callLabel(name: string, input: any): string {
  switch (name) {
    case "read": case "write": case "edit": return `${name} ${input?.path ?? ""}`;
    case "ls": return `ls ${input?.path ?? "."}${input?.pattern ? ` ${input.pattern}` : ""}`;
    case "grep": return `grep ${quote(input?.pattern)}${input?.path ? ` in ${input.path}` : ""}`;
    case "bash": return `bash ${String(input?.command ?? "").split("\n")[0]}`;
    case "todo": return `todo ${input?.action ?? ""}${input?.description ? ` ${quote(input.description)}` : ""}`;
    case "ask_user": return `ask_user ${quote(input?.question)}`;
    case "remember": return `remember ${quote(input?.fact)}`;
    default: return name;
  }
}

/** Short outcome suffix, after it runs, e.g. `(120 lines)`, `→ exit 1`, `(+3 −1)`. */
function resultSuffix(name: string, input: any, output: unknown): string {
  const out = typeof output === "string" ? output : JSON.stringify(output ?? "");
  if (/^User denied/.test(out)) return pc.yellow(" (denied)");
  if (/read-only/i.test(out) && /^(Error|Refused|Read-only|The session)/i.test(out)) return pc.yellow(" (read-only)");
  if (/^Error\b/.test(out)) return pc.red(` ✗ ${out.split("\n")[0]!.slice(0, 100)}`);
  switch (name) {
    case "read": return ` (${out.split("\n").filter((l) => /^\s*\d+[\t│|:]/.test(l)).length} lines)`;
    case "ls": return ` → ${out.split("\n").filter((l) => l.trim() && !l.startsWith("[")).length} entries`;
    case "grep": {
      const total = out.match(/(\d+)\s+(?:total\s+)?match/i);
      return ` → ${total ? total[1] : out.split("\n").filter((l) => /:\d+:/.test(l)).length} matches`;
    }
    case "bash": {
      const m = out.match(/^exit (\d+)/m);
      if (m) return ` → ${m[1] === "0" ? "exit 0" : pc.red(`exit ${m[1]}`)}`;
      return /timed out/i.test(out) ? pc.red(" → timed out") : "";
    }
    case "write": return ` (${lineCount(input?.content)} lines)`;
    case "edit": return ` (+${lineCount(input?.new_string)} −${lineCount(input?.old_string)})`;
    case "ask_user": return ` → ${quote(out, 50)}`;
    default: return "";
  }
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function formatFooter(u: TurnUsage, spec: string): string {
  return `${u.steps} step${u.steps === 1 ? "" : "s"} · ${fmtK(u.inputTokens)} in / ${fmtK(u.outputTokens)} out · ${(u.ms / 1000).toFixed(1)}s · ${spec}`;
}

export function createRenderer(o: { spinner?: Spinner; out?: NodeJS.WritableStream; err?: NodeJS.WritableStream } = {}) {
  const spinner = o.spinner ?? noSpinner;
  const out = o.out ?? process.stdout;
  const err = o.err ?? process.stderr;
  const calls = new Map<string, { name: string; input: unknown }>();
  let midLine = false; // stdout has text without a trailing newline

  const endText = () => {
    if (midLine) out.write("\n");
    midLine = false;
  };

  return {
    onChunk(c: Chunk): void {
      switch (c.type) {
        case "start-step":
          spinner.start("thinking");
          break;
        case "text-delta":
          if (!c.text) break;
          spinner.stop();
          out.write(c.text);
          midLine = !c.text.endsWith("\n");
          break;
        case "tool-call":
          spinner.stop();
          endText();
          calls.set(c.toolCallId, { name: c.toolName, input: c.input });
          spinner.start(callLabel(c.toolName, c.input));
          break;
        case "tool-result": {
          spinner.stop();
          const call = calls.get(c.toolCallId);
          const name = call?.name ?? c.toolName;
          err.write(pc.dim(`● ${callLabel(name, call?.input ?? c.input)}`) + resultSuffix(name, call?.input ?? c.input, c.output) + "\n");
          spinner.start("thinking");
          break;
        }
        case "tool-error": {
          spinner.stop();
          const msg = c.error instanceof Error ? c.error.message : String(c.error);
          err.write(pc.dim(`● ${callLabel(c.toolName, c.input)}`) + pc.red(` ✗ ${msg.split("\n")[0]}`) + "\n");
          break;
        }
        case "finish":
          spinner.stop();
          endText();
          break;
        case "abort":
          spinner.stop();
          endText();
          err.write(pc.yellow("(aborted)\n"));
          break;
        case "error":
          spinner.stop();
          endText();
          break;
      }
    },
    footer(u: TurnUsage, spec: string): void {
      spinner.stop();
      endText();
      err.write(pc.dim(formatFooter(u, spec)) + "\n");
    },
  };
}
