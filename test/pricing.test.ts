import { test, expect } from "bun:test";
import { priceKey, estimateCost, formatCost, type Price } from "../src/pricing.ts";

test("priceKey maps specs onto gateway catalog ids; local models are free", () => {
  expect(priceKey("gateway:anthropic/claude-sonnet-5.5")).toBe("anthropic/claude-sonnet-5.5");
  expect(priceKey("anthropic:claude-sonnet-5-5")).toBe("anthropic/claude-sonnet-5.5");
  expect(priceKey("openai:gpt-6.2-sol")).toBe("openai/gpt-6.2-sol");
  expect(priceKey("xai:grok-4.7")).toBe("spacexai/grok-4.7");
  expect(priceKey("openrouter:zai/glm-5.3")).toBe("zai/glm-5.3");
  expect(priceKey("ollama:qwen3:8b")).toBe("local");
  expect(priceKey("groq:openai/gpt-oss-120b")).toBeUndefined();
});

test("estimateCost uses input, cached-input and output prices", () => {
  const prices = new Map<string, Price>([["anthropic/claude-sonnet-5.5", { input: 2e-6, output: 1e-5, cacheRead: 1e-7 }]]);
  // 10k input (4k of it cached) + 1k output = 6000*2e-6 + 4000*1e-7 + 1000*1e-5
  expect(estimateCost(prices, "gateway:anthropic/claude-sonnet-5.5", { inputTokens: 10_000, outputTokens: 1_000, cachedInputTokens: 4_000 })).toBeCloseTo(0.0224, 6);
  expect(estimateCost(prices, "ollama:llama", { inputTokens: 5000, outputTokens: 500 })).toBe(0);
  expect(estimateCost(prices, "groq:x", { inputTokens: 1, outputTokens: 1 })).toBeUndefined();
});

test("formatCost", () => {
  expect(formatCost(undefined)).toBe("—");
  expect(formatCost(0)).toBe("$0");
  expect(formatCost(0.0034)).toBe("$0.0034");
  expect(formatCost(0.125)).toBe("$0.125");
});
