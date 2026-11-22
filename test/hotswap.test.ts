import { test, expect } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { createAgent, runTurn } from "../src/agent.ts";
import { formatFooter } from "../src/render.ts";
import type { ResolvedModel } from "../src/types.ts";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const finish = (unified: "stop" | "tool-calls") => ({ type: "finish" as const, usage, finishReason: { unified, raw: unified } });
const toolStep = (id: string) => ({
  stream: convertArrayToReadableStream<any>([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName: "ping", input: "{}" },
    finish("tool-calls"),
  ]),
});
const textStep = (text: string) => ({
  stream: convertArrayToReadableStream<any>([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    finish("stop"),
  ]),
});
const resolved = (model: MockLanguageModelV4, spec: string): ResolvedModel => ({ spec, provider: "mock", id: spec, model }) as ResolvedModel;

test("hot-swap: a model switched mid-turn takes over at the next step, with history intact", async () => {
  const a = new MockLanguageModelV4({ doStream: async () => toolStep("call-a") });
  const b = new MockLanguageModelV4({ doStream: async () => textStep("done by b") });
  const A = resolved(a, "mock:alpha"), B = resolved(b, "mock:beta");
  let current = A;
  const used: string[] = [];
  const tools = {
    // The first tool call stands in for the user pressing ctrl+p while the turn runs.
    ping: tool({ description: "ping", inputSchema: z.object({}), execute: async () => { current = B; return "pong"; } }),
  };
  const agent = createAgent({ model: A, tools, instructions: "test", currentModel: () => current, onStepModel: (s) => used.push(s) });
  const turn = await runTurn(agent, [{ role: "user", content: "go" }]);

  expect(used).toEqual(["mock:alpha", "mock:beta"]);
  expect(a.doStreamCalls).toHaveLength(1);
  expect(b.doStreamCalls).toHaveLength(1);
  // Model B saw A's tool call and its result: the conversation carried over.
  expect(JSON.stringify(b.doStreamCalls[0]!.prompt)).toContain("pong");
  expect(turn.text).toBe("done by b");
});

test("footer names the handoff when more than one model ran a turn", () => {
  const u = { steps: 3, toolCalls: 2, inputTokens: 1000, outputTokens: 50, ms: 2000 };
  expect(formatFooter({ ...u, models: ["gateway:anthropic/claude-haiku-5.5", "gateway:openai/gpt-6.2-sol"] }, "x")).toEndWith("claude-haiku-5.5 → gpt-6.2-sol");
  expect(formatFooter({ ...u, models: ["gateway:openai/gpt-6.2-sol"] }, "gateway:openai/gpt-6.2-sol")).toEndWith("gateway:openai/gpt-6.2-sol");
});
