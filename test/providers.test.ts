import { describe, expect, test } from "bun:test";
import { allProviders, baseURLOf, buildModel, BUILTIN_PROVIDERS } from "../src/providers.ts";

describe("provider configuration", () => {
  test("custom providers override a built-in ID and leave future registries intact", () => {
    const providers = allProviders({
      openai: {
        baseURL: "https://models.example.invalid/v1",
        apiKeyEnv: "LEX_TEST_API_KEY",
        label: "Custom OpenAI-compatible",
        models: ["custom-model"],
      },
      local: { baseURL: "http://127.0.0.1:8000/v1" },
    });
    expect(providers.filter((provider) => provider.id === "openai")).toEqual([{
      id: "openai",
      kind: "openai-compatible",
      env: "LEX_TEST_API_KEY",
      label: "Custom OpenAI-compatible",
      baseURL: "https://models.example.invalid/v1",
      models: ["custom-model"],
      local: false,
    }]);
    expect(providers.find((provider) => provider.id === "local")).toMatchObject({ label: "local", local: true, models: [] });
    expect(allProviders().find((provider) => provider.id === "openai")?.kind).toBe("openai");
  });

  test("a nonblank environment override takes precedence over the configured base URL", () => {
    const name = "LEX_TEST_COMPAT_BASE_URL";
    const saved = process.env[name];
    const provider = {
      id: "lex_test_compat",
      label: "Compatible endpoint",
      kind: "openai-compatible" as const,
      baseURL: "http://127.0.0.1:8000/v1",
      models: [],
    };
    try {
      process.env[name] = "  http://127.0.0.1:9000/v1  ";
      expect(baseURLOf(provider)).toBe("http://127.0.0.1:9000/v1");
      process.env[name] = "   ";
      expect(baseURLOf(provider)).toBe(provider.baseURL);
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  });

  test.each([
    ["gateway", "org/test-model", "gateway"],
    ["anthropic", "test-model", "anthropic"],
    ["openai", "test-model", "openai"],
    ["google", "test-model", "google"],
    ["ollama", "test-model:8b", "ollama"],
  ])("constructs the %s adapter with the requested model ID", (providerId, modelId, adapter) => {
    const provider = BUILTIN_PROVIDERS.find((candidate) => candidate.id === providerId)!;
    const model = buildModel(provider, modelId, "test-key");
    expect(model).toMatchObject({ modelId });
    expect(typeof model === "object" && model.provider.split(".")[0]).toBe(adapter);
  });
});
