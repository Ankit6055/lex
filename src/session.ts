// One conversation: model, tools, approval and message history. Shared by one-shot mode and the REPL.
import path from "node:path";
import type { ModelMessage, Tool } from "ai";
import type { Approver, IO, ResolvedModel, TurnUsage } from "./types.ts";
import { createAgent, runTurn, dropDanglingToolCalls, type Chunk, type TurnResult } from "./agent.ts";
import { resolveModel } from "./models.ts";
import { buildTools } from "./tools/index.ts";
import { loadContext } from "./context.ts";
import { buildSystemPrompt } from "./prompt.ts";

const PLAN_MODE_NOTE = "\n\n# Plan mode\nThe user turned on plan mode: file changes and non-read-only commands are refused. Investigate with read-only tools, then present a concise, numbered plan of the changes you would make, and ask the user to approve it (they leave plan mode with shift+tab).";

const CANCELLED_NOTE = "(The user cancelled this request before I finished. I won't continue it unless they ask again.)";

export interface SessionTotals extends TurnUsage {
  turns: number;
}

export interface Session {
  readonly root: string;
  readonly memoryPath: string;
  readonly io: IO;
  readonly approver: Approver;
  readonly tools: Record<string, Tool>;
  readonly model: ResolvedModel;
  readonly messages: ModelMessage[];
  readonly totals: SessionTotals;
  /** Swap the model. History is kept, so the next turn continues the same conversation. */
  setModel(spec: string): Promise<ResolvedModel>;
  /** Forget the conversation and reset per-session tool state (todos). */
  clear(): void;
  /** Run one user turn. On error the history is rolled back, so the turn can simply be retried. */
  turn(input: string, o?: { signal?: AbortSignal; onChunk?: (c: Chunk) => void }): Promise<TurnResult>;
}

export async function createSession(o: {
  root: string;
  io: IO;
  approver: Approver;
  model?: string;
  maxSteps?: number;
}): Promise<Session> {
  const memoryPath = path.join(o.root, ".lex", "memory.md");
  let model = await resolveModel(o.model);
  // `task` gets a getter, so its explorer follows `/model` swaps.
  const makeTools = () => buildTools({ root: o.root, approver: o.approver, io: o.io, memoryPath }, { getModel: () => model });
  let tools = makeTools();
  const messages: ModelMessage[] = [];
  const totals: SessionTotals = { turns: 0, steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, ms: 0 };

  return {
    root: o.root,
    memoryPath,
    io: o.io,
    approver: o.approver,
    get tools() { return tools; },
    get model() { return model; },
    messages,
    totals,

    async setModel(spec) {
      model = await resolveModel(spec);
      return model;
    },

    clear() {
      messages.length = 0;
      tools = makeTools();
    },

    async turn(input, t = {}) {
      const before = messages.length;
      messages.push({ role: "user", content: input });
      try {
        // Rebuilt every turn, so new memory, a swapped model or a mode change apply immediately.
        const ctx = await loadContext(o.root);
        const agent = createAgent({
          model,
          tools,
          instructions: buildSystemPrompt({ ...ctx, toolNames: Object.keys(tools) }) + (o.approver.mode === "readonly" ? PLAN_MODE_NOTE : ""),
          maxSteps: o.maxSteps,
        });
        const result = await runTurn(agent, messages, t);
        if (result.aborted) {
          // Keep finished work, and record the cancel so the model doesn't resume the request later.
          messages.push(...dropDanglingToolCalls(result.responseMessages), { role: "assistant", content: CANCELLED_NOTE });
        } else {
          messages.push(...result.responseMessages);
        }
        totals.turns++;
        totals.steps += result.usage.steps;
        totals.toolCalls += result.usage.toolCalls;
        totals.inputTokens += result.usage.inputTokens;
        totals.outputTokens += result.usage.outputTokens;
        totals.ms += result.usage.ms;
        if (result.usage.genMs) totals.genMs = (totals.genMs ?? 0) + result.usage.genMs;
        if (result.usage.genTokens) totals.genTokens = (totals.genTokens ?? 0) + result.usage.genTokens;
        return result;
      } catch (e) {
        messages.length = before;
        throw e;
      }
    },
  };
}
