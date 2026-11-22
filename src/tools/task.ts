// `task`: an explorer subagent. A fresh agent with read-only tools (read, ls, grep), a cheap model
// and a small step budget investigates one question and returns a short summary string.
import { tool, type ModelMessage, type Tool } from "ai";
import { z } from "zod";
import type { ModelInfo, ResolvedModel, ToolContext } from "../types.ts";
import { createAgent, runTurn } from "../agent.ts";
import { resolveModel } from "../models.ts";
import { createReadTool } from "./read.ts";
import { createLsTool } from "./ls.ts";
import { createGrepTool } from "./grep.ts";
import { capChars } from "../util/truncate.ts";

export const TASK_MAX_STEPS = 8;
export const TASK_MAX_CHARS = 4_000;

/** The cheap model to explore with, per provider of the parent model. Others reuse the parent's model. */
export const CHEAP_MODELS: Record<string, string> = {
  gateway: "gateway:anthropic/claude-haiku-5.5",
  anthropic: "anthropic:claude-haiku-5-5",
  openai: "openai:gpt-6.1-terra",
};

/** Spec of the cheap model for `parent`'s provider, or undefined to reuse the parent model. */
export function cheapModelSpec(parent: Pick<ModelInfo, "provider" | "spec">): string | undefined {
  const spec = CHEAP_MODELS[parent.provider];
  return spec && spec !== parent.spec ? spec : undefined;
}

export const EXPLORER_PROMPT = `You are an explorer subagent working for a coding agent. Investigate the question you are given using only your read-only tools (read, ls, grep), then answer it.

- Be efficient: you have at most ${TASK_MAX_STEPS} steps in total. Start with grep or ls to locate things, then read only the relevant parts.
- You cannot change files or run commands. Never guess: if you could not find something, say so.
- Finish with a concise summary (well under 300 words) that answers the question directly. Cite file paths with line numbers (e.g. src/agent.ts:42) for every relevant finding.`;

const WRAP_UP_PROMPT = "You are an explorer subagent that has run out of steps. Using only the findings given to you, answer the question with a concise summary that cites file paths and line numbers. Say what is still unknown.";
const WRAP_UP_ITEM_CHARS = 2_000;
const WRAP_UP_TOTAL_CHARS = 24_000;

const DESCRIPTION = `Delegate a read-only investigation to a subagent (read, ls, grep on a cheaper model). Returns a summary with file paths and line numbers.`;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const stringify = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * The explorer's run as plain text (its notes, tool calls and capped tool results), newest kept when
 * over budget. Plain text, not tool parts, so the wrap-up call needs no tools and no history pruning applies.
 */
export function transcript(messages: ModelMessage[]): string {
  const items: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      if (typeof m.content === "string") {
        if (m.content.trim()) items.push(`Note: ${m.content.trim()}`);
        continue;
      }
      for (const p of m.content) {
        if (p.type === "text" && p.text.trim()) items.push(`Note: ${p.text.trim()}`);
        else if (p.type === "tool-call") items.push(`Called ${p.toolName}(${stringify(p.input)})`);
      }
    } else if (m.role === "tool") {
      for (const p of m.content) {
        if (p.type !== "tool-result") continue;
        const out = p.output as { type: string; value?: unknown; reason?: string };
        const value = out.type === "execution-denied" ? `denied${out.reason ? `: ${out.reason}` : ""}` : stringify(out.value ?? "");
        items.push(`Result of ${p.toolName}:\n${capChars(value, WRAP_UP_ITEM_CHARS)}`);
      }
    }
  }
  const kept: string[] = [];
  let size = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    size += items[i]!.length + 2;
    if (size > WRAP_UP_TOTAL_CHARS) {
      kept.unshift(`[${i + 1} earlier item(s) omitted]`);
      break;
    }
    kept.unshift(items[i]!);
  }
  return kept.join("\n\n");
}

export function createTaskTool(
  ctx: ToolContext,
  o: {
    /** The parent session's current model. A getter, because `/model` can swap it mid-session. */
    getModel: () => ResolvedModel;
    /** Injectable for tests; defaults to resolveModel. */
    resolve?: (spec: string) => Promise<ResolvedModel>;
  },
): Tool {
  const resolve = o.resolve ?? resolveModel;
  // Resolved lazily (and once) per parent model; a failed lookup falls back to the parent model.
  const cheap = new Map<string, Promise<ResolvedModel | undefined>>();

  async function explorerModel(): Promise<ResolvedModel> {
    const parent = o.getModel();
    const spec = cheapModelSpec(parent);
    if (!spec) return parent;
    let p = cheap.get(spec);
    if (!p) {
      p = resolve(spec).catch(() => undefined);
      cheap.set(spec, p);
    }
    return (await p) ?? parent;
  }

  const tools = { read: createReadTool(ctx), ls: createLsTool(ctx), grep: createGrepTool(ctx) };

  return tool({
    description: DESCRIPTION,
    inputSchema: z.object({
      description: z.string().describe("Self-contained question to investigate"),
    }),
    execute: async ({ description }, { abortSignal }) => {
      const question = description.trim();
      if (!question) return "Error: description is empty. Say what the explorer should investigate.";
      try {
        const model = await explorerModel();
        const agent = createAgent({ model, tools, instructions: EXPLORER_PROMPT, maxSteps: TASK_MAX_STEPS });
        const messages: ModelMessage[] = [{ role: "user", content: question }];
        const first = await runTurn(agent, messages, { signal: abortSignal });
        if (first.aborted) return "Error: task was cancelled.";

        let text = first.text.trim();
        if (!text) {
          // Hit the step budget mid-search: one tool-less call turns the findings so far into a summary.
          const findings = transcript(first.responseMessages);
          if (findings) {
            const wrapUp = createAgent({ model, tools: {}, instructions: WRAP_UP_PROMPT, maxSteps: 1 });
            const content = `Question: ${question}\n\nFindings so far:\n\n${findings}`;
            const second = await runTurn(wrapUp, [{ role: "user", content }], { signal: abortSignal });
            if (second.aborted) return "Error: task was cancelled.";
            text = second.text.trim();
          }
        }
        if (!text) return `Error: the explorer used all ${TASK_MAX_STEPS} steps without producing a summary. Try a narrower description.`;
        return capChars(text, TASK_MAX_CHARS);
      } catch (e) {
        if (abortSignal?.aborted) return "Error: task was cancelled.";
        return `Error: explorer failed: ${errorText(e)}`;
      }
    },
  });
}
