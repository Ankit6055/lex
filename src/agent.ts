// The whole loop: a ToolLoopAgent plus a streaming turn runner.
import { ToolLoopAgent, isStepCount, pruneMessages } from "ai";
import type { ModelMessage, TextStreamPart, Tool, ToolSet } from "ai";
import type { ResolvedModel, TurnUsage } from "./types.ts";
import { redact } from "./auth.ts";

export type LexAgent = ToolLoopAgent<never, Record<string, Tool>>;
export type Chunk = TextStreamPart<ToolSet>;

export function createAgent(o: {
  model: ResolvedModel;
  tools: Record<string, Tool>;
  instructions: string;
  maxSteps?: number;
}): LexAgent {
  return new ToolLoopAgent({
    model: o.model.model,
    instructions: o.instructions,
    tools: o.tools,
    stopWhen: isStepCount(o.maxSteps ?? 25),
    prepareStep: ({ initialMessages, responseMessages }) => ({ messages: contextFor(initialMessages, responseMessages) }),
  });
}

/** Past this size (in JSON chars, roughly 4 per token) the current turn's older tool output is pruned too. */
const TURN_BUDGET_CHARS = 400_000;

/**
 * Context hygiene, run before every step:
 * - earlier turns keep their conversation text but drop tool call/result bodies (stale, and the bulk of the tokens);
 * - the current turn keeps everything, so the model never forgets a file it read two steps ago,
 *   unless it grows past the budget, in which case only its last 10 messages keep tool bodies.
 */
export function contextFor(history: ModelMessage[], turn: ModelMessage[]): ModelMessage[] {
  const past = pruneMessages({ messages: history, toolCalls: "all", emptyMessages: "remove" });
  const current = JSON.stringify(turn).length > TURN_BUDGET_CHARS
    ? pruneMessages({ messages: turn, toolCalls: "before-last-10-messages", emptyMessages: "remove" })
    : turn;
  return [...past, ...current];
}

export interface TurnResult {
  responseMessages: ModelMessage[];
  text: string;
  usage: TurnUsage;
  aborted: boolean;
}

/** Stream one user turn (the full history in, new response messages out). */
export async function runTurn(
  agent: LexAgent,
  messages: ModelMessage[],
  o: { signal?: AbortSignal; onChunk?: (c: Chunk) => void } = {},
): Promise<TurnResult> {
  const start = Date.now();
  const usage: TurnUsage = { steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, ms: 0 };
  let error: unknown;
  let aborted = false;

  const result = await agent.stream({ messages, abortSignal: o.signal });
  try {
    for await (const c of result.fullStream) {
      o.onChunk?.(c);
      if (c.type === "tool-call") usage.toolCalls++;
      else if (c.type === "finish-step") {
        usage.steps++;
        usage.inputTokens += c.usage.inputTokens ?? 0;
        usage.outputTokens += c.usage.outputTokens ?? 0;
      } else if (c.type === "abort") aborted = true;
      else if (c.type === "error") error ??= c.error;
    }
  } catch (e) {
    if (o.signal?.aborted) aborted = true;
    else error ??= e;
  }
  usage.ms = Date.now() - start;

  if (aborted || o.signal?.aborted) {
    // Keep whatever finished before the abort so history stays consistent.
    const responseMessages = await Promise.resolve(result.responseMessages).catch(() => []);
    return { responseMessages, text: "", usage, aborted: true };
  }
  if (error) throw new Error(redact(errorMessage(error)));

  const [responseMessages, text] = await Promise.all([result.responseMessages, result.text]);
  return { responseMessages, text, usage, aborted: false };
}

/**
 * After an abort, the last assistant message can hold tool calls that never got a result.
 * Providers reject such history, so drop those calls (and any message left empty).
 */
export function dropDanglingToolCalls(messages: ModelMessage[]): ModelMessage[] {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool") for (const p of m.content) if (p.type === "tool-result") answered.add(p.toolCallId);
  }
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const content = m.content.filter((p) => p.type !== "tool-call" || answered.has(p.toolCallId));
      if (content.length) out.push({ ...m, content });
    } else {
      out.push(m);
    }
  }
  return out;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const status = (e as { statusCode?: number }).statusCode;
    return status ? `${e.message} (HTTP ${status})` : e.message;
  }
  return String(e);
}
