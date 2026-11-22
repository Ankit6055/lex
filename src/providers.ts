// The provider registry: one row per provider. Most providers speak the OpenAI-compatible API,
// so adding one is a single entry here. Users can add their own endpoints in ~/.lex/config.json.
import { createGateway } from "ai";
import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export type ProviderKind = "gateway" | "anthropic" | "openai" | "google" | "openai-compatible";

export interface ProviderDef {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Env var holding the API key. Absent for local servers that need no key. */
  env?: string;
  /** OpenAI-compatible base URL. Overridable with `<ID>_BASE_URL`, e.g. OLLAMA_BASE_URL. */
  baseURL?: string;
  /** Default model candidates, best first. The first one the provider actually lists wins. */
  models: string[];
  /** Local server: never picked automatically, only when asked for by name. */
  local?: boolean;
}

/** Built-in providers, in the order used to pick a default when no model is configured. */
export const BUILTIN_PROVIDERS: ProviderDef[] = [
  { id: "gateway", label: "Vercel AI Gateway (one key, hundreds of models)", kind: "gateway", env: "AI_GATEWAY_API_KEY",
    models: ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "anthropic/claude-haiku-5.5", "openai/gpt-6.2-sol", "google/gemini-4-neon", "spacexai/grok-4.7", "zai/glm-5.3", "moonshotai/kimi-k3", "deepseek/deepseek-v4-pro"] },
  { id: "anthropic", label: "Anthropic", kind: "anthropic", env: "ANTHROPIC_API_KEY",
    models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"] },
  { id: "openai", label: "OpenAI", kind: "openai", env: "OPENAI_API_KEY",
    models: ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra"] },
  { id: "openrouter", label: "OpenRouter", kind: "openai-compatible", env: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1",
    models: ["anthropic/claude-sonnet-5.5", "openai/gpt-6.2-sol", "google/gemini-4-neon", "moonshotai/kimi-k3"] },
  { id: "google", label: "Google Gemini", kind: "google", env: "GEMINI_API_KEY",
    models: ["gemini-4-neon", "gemini-4-argon", "gemini-3.8-flash"] },
  { id: "xai", label: "xAI Grok", kind: "openai-compatible", env: "XAI_API_KEY", baseURL: "https://api.x.ai/v1",
    models: ["grok-4.7", "grok-4.6", "grok-4.5"] },
  { id: "deepseek", label: "DeepSeek", kind: "openai-compatible", env: "DEEPSEEK_API_KEY", baseURL: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "mistral", label: "Mistral", kind: "openai-compatible", env: "MISTRAL_API_KEY", baseURL: "https://api.mistral.ai/v1",
    models: ["mistral-large-latest", "devstral-latest", "mistral-medium-latest"] },
  { id: "groq", label: "Groq", kind: "openai-compatible", env: "GROQ_API_KEY", baseURL: "https://api.groq.com/openai/v1",
    models: ["openai/gpt-oss-120b", "moonshotai/kimi-k2-instruct", "llama-3.3-70b-versatile"] },
  { id: "cerebras", label: "Cerebras", kind: "openai-compatible", env: "CEREBRAS_API_KEY", baseURL: "https://api.cerebras.ai/v1",
    models: ["gpt-oss-120b", "zai-glm-4.7", "qwen-3-235b-a22b-instruct-2507"] },
  { id: "together", label: "Together AI", kind: "openai-compatible", env: "TOGETHER_API_KEY", baseURL: "https://api.together.xyz/v1",
    models: ["moonshotai/Kimi-K2-Instruct", "deepseek-ai/DeepSeek-V3.1", "openai/gpt-oss-120b"] },
  { id: "fireworks", label: "Fireworks", kind: "openai-compatible", env: "FIREWORKS_API_KEY", baseURL: "https://api.fireworks.ai/inference/v1",
    models: ["accounts/fireworks/models/kimi-k2-instruct", "accounts/fireworks/models/deepseek-v3p1", "accounts/fireworks/models/gpt-oss-120b"] },
  { id: "moonshot", label: "Moonshot AI (Kimi)", kind: "openai-compatible", env: "MOONSHOT_API_KEY", baseURL: "https://api.moonshot.ai/v1",
    models: ["kimi-k3", "kimi-k2.6", "kimi-latest"] },
  { id: "zai", label: "Z.ai (GLM)", kind: "openai-compatible", env: "ZAI_API_KEY", baseURL: "https://api.z.ai/api/paas/v4",
    models: ["glm-5.3", "glm-5.1", "glm-4.6"] },
  { id: "minimax", label: "MiniMax", kind: "openai-compatible", env: "MINIMAX_API_KEY", baseURL: "https://api.minimax.io/v1",
    models: ["MiniMax-M3", "MiniMax-M2.7"] },
  { id: "nvidia", label: "NVIDIA NIM", kind: "openai-compatible", env: "NVIDIA_API_KEY", baseURL: "https://integrate.api.nvidia.com/v1",
    models: ["nvidia/nemotron-3-super-120b-a12b", "moonshotai/kimi-k2-instruct"] },
  { id: "huggingface", label: "Hugging Face", kind: "openai-compatible", env: "HF_TOKEN", baseURL: "https://router.huggingface.co/v1",
    models: ["moonshotai/Kimi-K2-Instruct", "openai/gpt-oss-120b"] },
  { id: "ollama", label: "Ollama (local)", kind: "openai-compatible", baseURL: "http://localhost:11434/v1", models: [], local: true },
  { id: "lmstudio", label: "LM Studio (local)", kind: "openai-compatible", baseURL: "http://localhost:1234/v1", models: [], local: true },
];

/** A user-defined OpenAI-compatible endpoint from ~/.lex/config.json `providers`. */
export interface CustomProviderConfig {
  baseURL: string;
  apiKeyEnv?: string;
  models?: string[];
  label?: string;
}

/** Built-ins plus custom providers (a custom entry with a built-in id overrides it). */
export function allProviders(custom: Record<string, CustomProviderConfig> = {}): ProviderDef[] {
  const extra: ProviderDef[] = Object.entries(custom).map(([id, c]) => ({
    id,
    label: c.label ?? id,
    kind: "openai-compatible",
    env: c.apiKeyEnv,
    baseURL: c.baseURL,
    models: c.models ?? [],
    local: !c.apiKeyEnv,
  }));
  const ids = new Set(extra.map((p) => p.id));
  return [...BUILTIN_PROVIDERS.filter((p) => !ids.has(p.id)), ...extra];
}

export function baseURLOf(p: ProviderDef): string | undefined {
  return process.env[`${p.id.toUpperCase()}_BASE_URL`]?.trim() || p.baseURL;
}

export function buildModel(p: ProviderDef, id: string, apiKey: string | undefined): LanguageModel {
  switch (p.kind) {
    case "gateway": return createGateway({ apiKey })(id);
    case "anthropic": return createAnthropic({ apiKey })(id);
    case "openai": return createOpenAI({ apiKey })(id);
    case "google": return createGoogleGenerativeAI({ apiKey })(id);
    case "openai-compatible":
      return createOpenAICompatible({ name: p.id, baseURL: baseURLOf(p)!, apiKey, includeUsage: true })(id);
  }
}

async function getJson(url: string, headers: Record<string, string>, ms: number): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Live model ids from the provider's own catalog endpoint. Throws if unreachable. */
export async function fetchModelIds(p: ProviderDef, apiKey: string | undefined, ms = 5000): Promise<string[]> {
  switch (p.kind) {
    case "gateway": {
      const r = await createGateway({ apiKey }).getAvailableModels();
      return r.models.filter((m) => !m.modelType || m.modelType === "language").map((m) => m.id);
    }
    case "anthropic": {
      const r = await getJson("https://api.anthropic.com/v1/models?limit=1000", { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" }, ms);
      return r.data.map((m: { id: string }) => m.id);
    }
    case "google": {
      const r = await getJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { "x-goog-api-key": apiKey ?? "" }, ms);
      return r.models
        .filter((m: { supportedGenerationMethods?: string[] }) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m: { name: string }) => m.name.replace(/^models\//, ""));
    }
    case "openai":
    case "openai-compatible": {
      const base = p.kind === "openai" ? "https://api.openai.com/v1" : baseURLOf(p)!;
      const r = await getJson(`${base.replace(/\/$/, "")}/models`, apiKey ? { authorization: `Bearer ${apiKey}` } : {}, ms);
      return (r.data ?? r.models ?? []).map((m: { id?: string; name?: string }) => m.id ?? m.name).filter(Boolean);
    }
  }
}
