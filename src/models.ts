// The model layer: what makes the model swappable. Three providers, each with your own key.
import { createGateway } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ModelInfo, ProviderId, ResolvedModel } from "./types.ts";
import { ENV_VARS, PROVIDERS, getKey, readConfig } from "./auth.ts";

/** Verified 2026-11-22. Gateway ids use dots; direct Anthropic ids use dashes. */
export const DEFAULTS: Record<ProviderId, string> = {
  gateway: "anthropic/claude-sonnet-5.5",
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-6.2-sol",
};

const SHORTLIST: Record<ProviderId, string[]> = {
  gateway: ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "anthropic/claude-haiku-5.5", "openai/gpt-6.2-sol", "openai/gpt-6.2-astra", "zai/glm-5.3"],
  anthropic: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
  openai: ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra"],
};

export const NO_KEY_MESSAGE = `No API key found. Lex is bring-your-own-key. Set one of:
  AI_GATEWAY_API_KEY   (recommended: one key, every model. vercel.com/ai-gateway)
  ANTHROPIC_API_KEY    OPENAI_API_KEY
or run: lex login`;

export class ModelError extends Error {
  override name = "ModelError";
}

/** `claude-sonnet-5-5` -> `claude-sonnet-5.5` (gateway style). */
const toGatewayClaude = (id: string) => id.replace(/-(\d+)-(\d+)$/, "-$1.$2");
/** `claude-sonnet-5.5` -> `claude-sonnet-5-5` (Anthropic API style). */
const toAnthropicClaude = (id: string) => id.replace(/(\d+)\.(\d+)$/, "$1-$2");

/**
 * Pure spec parser (§4.1). `hasKey` decides where a bare `claude-*` / `gpt-*` id goes.
 *   provider:id         explicit
 *   creator/model       gateway
 *   claude-* / gpt-* / o<digit>*   direct provider if its key exists, else gateway
 */
export function parseSpec(spec: string, hasKey: (p: ProviderId) => boolean): { provider: ProviderId; id: string } {
  const s = spec.trim();
  const colon = s.indexOf(":");
  if (colon > 0) {
    const provider = s.slice(0, colon) as ProviderId;
    const id = s.slice(colon + 1);
    if (!PROVIDERS.includes(provider)) {
      throw new ModelError(`Unknown provider "${s.slice(0, colon)}". Use one of: ${PROVIDERS.join(", ")} (e.g. gateway:${DEFAULTS.gateway}).`);
    }
    if (!id) throw new ModelError(`Missing model id after "${provider}:". e.g. ${provider}:${DEFAULTS[provider]}`);
    return { provider, id: provider === "anthropic" ? toAnthropicClaude(id) : id };
  }
  if (s.includes("/")) return { provider: "gateway", id: s };
  if (s.startsWith("claude-")) {
    return hasKey("anthropic") ? { provider: "anthropic", id: toAnthropicClaude(s) } : { provider: "gateway", id: `anthropic/${toGatewayClaude(s)}` };
  }
  if (s.startsWith("gpt-") || /^o\d/.test(s)) {
    return hasKey("openai") ? { provider: "openai", id: s } : { provider: "gateway", id: `openai/${s}` };
  }
  throw new ModelError(`Can't tell which provider "${s}" belongs to. Use provider:id, e.g. gateway:${DEFAULTS.gateway} or anthropic:${DEFAULTS.anthropic}.`);
}

async function keysPresent(): Promise<Record<ProviderId, string | undefined>> {
  const [gateway, anthropic, openai] = await Promise.all(PROVIDERS.map(getKey));
  return { gateway, anthropic, openai };
}

function build(provider: ProviderId, id: string, apiKey: string): LanguageModel {
  switch (provider) {
    case "gateway": return createGateway({ apiKey })(id);
    case "anthropic": return createAnthropic({ apiKey })(id);
    case "openai": return createOpenAI({ apiKey })(id);
  }
}

let gatewayCache: Promise<string[] | undefined> | undefined;
/** Live gateway language-model ids, cached for the session. `undefined` if unreachable. */
export function gatewayModels(apiKey: string): Promise<string[] | undefined> {
  gatewayCache ??= Promise.race([
    createGateway({ apiKey }).getAvailableModels().then((r) =>
      r.models.filter((m) => !m.modelType || m.modelType === "language").map((m) => m.id),
    ),
    new Promise<undefined>((res) => setTimeout(res, 5000).unref?.()),
  ]).catch(() => undefined);
  return gatewayCache;
}

/** Up to `n` candidates closest to `query` (substring hits first, then edit distance). */
export function closeMatches(query: string, candidates: string[], n = 5): string[] {
  const q = query.toLowerCase();
  const tail = q.split("/").pop()!;
  const dist = (a: string, b: string) => {
    const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = dp[0]!;
      dp[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = dp[j]!;
        dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return dp[b.length]!;
  };
  return candidates
    .map((c) => {
      const lc = c.toLowerCase();
      const score = lc.includes(tail) ? -1000 + lc.length : Math.min(dist(q, lc), dist(tail, lc.split("/").pop()!));
      return { c, score };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, n)
    .map((x) => x.c);
}

/**
 * Resolution order: spec arg (--model) → LEX_MODEL → config.json defaultModel →
 * first provider with a key (gateway → anthropic → openai).
 */
export async function resolveModel(spec?: string): Promise<ResolvedModel> {
  const keys = await keysPresent();
  const chosen = spec || process.env.LEX_MODEL || (await readConfig()).defaultModel;
  let provider: ProviderId, id: string;
  if (chosen) {
    ({ provider, id } = parseSpec(chosen, (p) => !!keys[p]));
  } else {
    const first = PROVIDERS.find((p) => keys[p]);
    if (!first) throw new ModelError(NO_KEY_MESSAGE);
    provider = first;
    id = DEFAULTS[first];
  }
  const apiKey = keys[provider];
  if (!apiKey) {
    throw new ModelError(
      PROVIDERS.some((p) => keys[p])
        ? `No ${provider} key. Set ${ENV_VARS[provider]} or run: lex login`
        : NO_KEY_MESSAGE,
    );
  }
  if (provider === "gateway") {
    const live = await gatewayModels(apiKey);
    if (live && !live.includes(id)) {
      const near = closeMatches(id, live);
      throw new ModelError(`Unknown gateway model "${id}".${near.length ? ` Did you mean:\n  ${near.map((m) => `gateway:${m}`).join("\n  ")}` : ""}`);
    }
  }
  return { spec: `${provider}:${id}`, provider, id, model: build(provider, id, apiKey) };
}

/** A short, curated list for `/model` (the full gateway list is hundreds of entries). */
export async function suggestedModels(): Promise<ModelInfo[]> {
  const keys = await keysPresent();
  return PROVIDERS.filter((p) => keys[p]).flatMap((provider) =>
    SHORTLIST[provider].map((id) => ({ spec: `${provider}:${id}`, provider, id })),
  );
}

/** Models reachable with the keys you have: live gateway list plus static direct shortlists. */
export async function listAvailable(): Promise<ModelInfo[]> {
  const keys = await keysPresent();
  const out: ModelInfo[] = [];
  for (const provider of PROVIDERS) {
    const key = keys[provider];
    if (!key) continue;
    const ids = provider === "gateway" ? ((await gatewayModels(key)) ?? SHORTLIST.gateway) : SHORTLIST[provider];
    for (const id of ids) out.push({ spec: `${provider}:${id}`, provider, id });
  }
  return out;
}
