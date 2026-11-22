// How a turn looks in the interactive terminal: assistant text and one block per tool call,
// printed to scrollback, plus live activity stats (label, tokens, tokens/second) for the spinner.
import type { Chunk } from "../agent.ts";
import type { Screen } from "./screen.ts";
import { t, bold } from "./theme.ts";
import { truncate } from "./text.ts";

const one = (s: unknown, n = 60) => truncate(String(s ?? "").replace(/\s+/g, " ").trim(), n);
const q = (s: unknown, n = 50) => `"${one(s, n)}"`;

/** `Read(src/x.ts)`-style title for a tool call. */
export function toolTitle(name: string, input: any): { name: string; arg: string } {
  switch (name) {
    case "read": return { name: "Read", arg: `${input?.path ?? ""}${input?.offset ? `:${input.offset}` : ""}` };
    case "ls": return { name: "List", arg: `${input?.path ?? "."}${input?.pattern ? ` ${input.pattern}` : ""}` };
    case "grep": return { name: "Search", arg: `${q(input?.pattern, 40)}${input?.path ? ` in ${input.path}` : ""}` };
    case "write": return { name: "Write", arg: input?.path ?? "" };
    case "edit": return { name: "Update", arg: input?.path ?? "" };
    case "bash": return { name: "Bash", arg: one(String(input?.command ?? "").split("\n")[0], 80) };
    case "todo": return { name: "Todo", arg: `${input?.action ?? ""}${input?.description ? ` ${q(input.description, 40)}` : ""}` };
    case "ask_user": return { name: "Ask", arg: q(input?.question) };
    case "remember": return { name: "Remember", arg: q(input?.fact) };
    case "task": return { name: "Task", arg: q(input?.description) };
    case "load_skill": return { name: "Skill", arg: input?.name ?? "" };
    default: return { name, arg: "" };
  }
}

const lines = (s: unknown) => (typeof s === "string" && s ? s.split("\n").length : 0);

/** Status and detail lines for a finished tool call. */
export function toolOutcome(name: string, input: any, output: unknown): { status: "ok" | "error" | "denied"; lines: string[] } {
  const out = typeof output === "string" ? output : JSON.stringify(output ?? "");
  if (/^User denied/.test(out)) return { status: "denied", lines: [t.gold("Denied")] };
  if (/read-only|plan mode/i.test(out) && /^(Refused|The session)/.test(out)) return { status: "denied", lines: [t.gold("Skipped: plan mode is on")] };
  if (/^Error\b/.test(out)) return { status: "error", lines: [t.coral(one(out.replace(/^Error:\s*/, ""), 110))] };
  switch (name) {
    case "read": return { status: "ok", lines: [`Read ${out.split("\n").filter((l) => /^\s*\d+[\t│|:]/.test(l)).length} lines`] };
    case "ls": return { status: "ok", lines: [`${out.split("\n").filter((l) => l.trim() && !l.startsWith("[")).length} entries`] };
    case "grep": {
      const total = out.match(/(\d+)\s+(?:total\s+)?match/i);
      return { status: "ok", lines: [`${total ? total[1] : out.split("\n").filter((l) => /:\d+:/.test(l)).length} matches`] };
    }
    case "bash": {
      const code = out.match(/^exit (\d+)/m)?.[1];
      const body = out.replace(/^exit \d+\n?/m, "").split("\n").filter((l) => l.trim());
      const tail = body.slice(-4).map((l) => t.shade(truncate(l, 100)));
      const head = code === undefined ? (/timed out/i.test(out) ? t.coral("Timed out") : "Done") : code === "0" ? "exit 0" : t.coral(`exit ${code}`);
      return { status: code && code !== "0" ? "error" : "ok", lines: [body.length > 4 ? `${head} ${t.shade(`· ${body.length} lines`)}` : head, ...tail] };
    }
    case "write": return { status: "ok", lines: [`Wrote ${lines(input?.content)} lines`] };
    case "edit": {
      const stats = out.match(/\(\+(\d+) −(\d+)\)/);
      const diff = [
        ...String(input?.old_string ?? "").split("\n").slice(0, 4).map((l) => t.coral(`- ${truncate(l, 100)}`)),
        ...String(input?.new_string ?? "").split("\n").slice(0, 4).map((l) => t.aqua(`+ ${truncate(l, 100)}`)),
      ];
      return { status: "ok", lines: [stats ? `${t.aqua(`+${stats[1]}`)} ${t.coral(`−${stats[2]}`)}` : "Updated", ...diff] };
    }
    case "todo": {
      const items = out.split("\n").filter((l) => /^\s*\[[ x~]\]/.test(l)).slice(0, 12).map((l) =>
        l.replace(/^\s*\[x\]/, t.aqua("✔")).replace(/^\s*\[~\]/, t.gold("◐")).replace(/^\s*\[ \]/, t.shade("○")));
      return { status: "ok", lines: items.length ? items : [one(out, 100)] };
    }
    case "ask_user": return { status: "ok", lines: [`→ ${one(out, 90)}`] };
    case "remember": return { status: "ok", lines: ["Saved to memory"] };
    case "task": return { status: "ok", lines: out.split("\n").filter((l) => l.trim()).slice(0, 3).map((l) => t.shade(truncate(l, 100))) };
    case "load_skill": return { status: "ok", lines: [`Loaded ${lines(out)} lines`] };
    default: return { status: "ok", lines: [] };
  }
}

export interface Activity {
  label: string;
  startedAt: number;
  outTokens: number;     // finished steps (exact) + current step (estimated from streamed chars)
  tps?: number;          // tokens/second while generating
  ctxTokens?: number;    // input tokens of the latest step: how full the context is
}

export function createTranscript(screen: Screen) {
  const calls = new Map<string, { name: string; input: unknown }>();
  const act: Activity = { label: "Thinking", startedAt: Date.now(), outTokens: 0 };
  let doneTokens = 0, stepChars = 0, stepFirst = 0, inText = false, pendingNL = 0, blocks = 0;

  let streamChars = 0; // text + reasoning only: tool arguments arrive in bursts and would skew speed
  const count = (n: number, streamed = true) => {
    if (!stepFirst) stepFirst = Date.now();
    stepChars += n;
    if (streamed) streamChars += n;
    act.outTokens = doneTokens + Math.round(stepChars / 4);
    const secs = (Date.now() - stepFirst) / 1000;
    if (secs > 0.5 && streamChars >= 160) act.tps = streamChars / 4 / secs;
  };

  const startBlock = () => {
    if (blocks++ > 0) screen.print("");
  };

  const endText = () => {
    if (!inText) return;
    screen.flushText();
    inText = false;
    pendingNL = 0;
  };

  const printTool = (name: string, input: unknown, status: "ok" | "error" | "denied", detail: string[]) => {
    endText();
    startBlock();
    const dot = status === "ok" ? t.aqua("●") : status === "denied" ? t.gold("●") : t.coral("●");
    const title = toolTitle(name, input);
    const out = [`${dot} ${bold(t.ink(title.name))}${title.arg ? t.mist(`(${title.arg})`) : ""}`];
    detail.forEach((l, i) => out.push(`  ${i === 0 ? t.hair("└") : " "} ${i === 0 ? t.mist(l) : l}`));
    screen.print(out.join("\n"));
  };

  return {
    activity: act,
    onChunk(c: Chunk): void {
      switch (c.type) {
        case "start-step":
          act.label = "Thinking";
          stepChars = 0;
          streamChars = 0;
          stepFirst = 0;
          break;
        case "text-delta": {
          if (!c.text) break;
          count(c.text.length);
          if (!inText) { startBlock(); screen.wrapIndent = "  "; screen.streamText("● "); inText = true; pendingNL = 0; }
          let out = "";
          for (const ch of c.text) {
            if (ch === "\n") { pendingNL++; continue; }
            if (pendingNL) { out += "\n".repeat(pendingNL) + "  "; pendingNL = 0; }
            out += ch;
          }
          if (out) screen.streamText(out);
          act.label = "Writing";
          break;
        }
        case "reasoning-delta":
          count(c.text.length);
          act.label = "Thinking";
          break;
        case "tool-input-delta":
          count(c.delta.length, false);
          break;
        case "tool-input-start": {
          endText();
          act.label = `Preparing ${toolTitle(c.toolName, {}).name}`;
          break;
        }
        case "tool-call": {
          endText();
          calls.set(c.toolCallId, { name: c.toolName, input: c.input });
          const title = toolTitle(c.toolName, c.input);
          act.label = `${title.name}${title.arg ? `(${one(title.arg, 40)})` : ""}`;
          break;
        }
        case "tool-result": {
          const call = calls.get(c.toolCallId);
          const name = call?.name ?? c.toolName;
          const input = call?.input ?? c.input;
          const o = toolOutcome(name, input, c.output);
          printTool(name, input, o.status, o.lines);
          act.label = "Thinking";
          break;
        }
        case "tool-error": {
          const msg = c.error instanceof Error ? c.error.message : String(c.error);
          printTool(c.toolName, c.input, "error", [t.coral(one(msg, 110))]);
          break;
        }
        case "finish-step":
          doneTokens += c.usage.outputTokens ?? Math.round(stepChars / 4);
          act.outTokens = doneTokens;
          stepChars = 0;
          stepFirst = 0;
          {
            const out = c.usage.outputTokens ?? 0, tps = c.performance?.outputTokensPerSecond;
            if (out >= 20 && tps && (out / tps) * 1000 >= 250) act.tps = tps;
          }
          if (c.usage.inputTokens) act.ctxTokens = c.usage.inputTokens;
          break;
        case "finish":
        case "error":
          endText();
          break;
        case "abort":
          endText();
          screen.print(t.gold("  ⎿ Interrupted · tell lex what to do instead"));
          break;
      }
    },
    endText,
  };
}
