// The model layer: what makes the model swappable. Specs like `groq:openai/gpt-oss-120b` are
// resolved against the provider registry (src/providers.ts) using your own keys.
import type { ModelInfo, ProviderId, ResolvedModel } from "./types.ts";
import { BUILTIN_PROVIDERS, baseURLOf, buildModel, fetchModelIds, type ProviderDef } from "./providers.ts";
import { getKey, getProviders, readConfig } from "./auth.ts";

/** First default candidate per built-in provider (the live catalog may pick a later one). */
export const DEFAULTS: Record<ProviderId, string> = Object.fromEntries(
  BUILTIN_PROVIDERS.filter((p) => p.models.length).map((p) => [p.id, p.models[0]!]),
);

/** The command that launched lex (npx or a global install), so hints show something that works as typed. */
export function lexCommand(): string {
  return process.env.npm_command === "exec" || /[\\/]_npx[\\/]/.test(process.argv[1] ?? "") ? "npx @ankit6055/lex" : "lex";
}

export function noKeyMessage(): string {
  const cmd = lexCommand();
  return `No API key found. lex is installed fine; it just needs a key to talk to a model.

Log in now:  ${cmd} login
Or set one of these and run ${cmd} again:
  AI_GATEWAY_API_KEY   (recommended: one key, every model. vercel.com/ai-gateway)
  ANTHROPIC_API_KEY  OPENAI_API_KEY  OPENROUTER_API_KEY  GEMINI_API_KEY  XAI_API_KEY
  DEEPSEEK_API_KEY  MISTRAL_API_KEY  GROQ_API_KEY  ... (see: ${cmd} --help)`;
}

/** @deprecated use noKeyMessage(); kept for callers that compare messages. */
export const NO_KEY_MESSAGE = noKeyMessage();

export class ModelError extends Error {
  override name = "ModelError";
}

/** No provider key is configured at all: interactive callers offer login instead of failing. */
export class NoKeyError extends ModelError {
  override name = "NoKeyError";
  constructor() {
    super(noKeyMessage());
  }
}

/** `claude-sonnet-5-5` -> `claude-sonnet-5.5` (gateway style). */
const toGatewayClaude = (id: string) => id.replace(/-(\d+)-(\d+)$/, "-$1.$2");
/** `claude-sonnet-5.5` -> `claude-sonnet-5-5` (Anthropic API style). */
const toAnthropicClaude = (id: string) => id.replace(/(\d+)\.(\d+)$/, "$1-$2");

/** Bare model-name prefixes and the direct provider (and gateway creator) that owns them. */
const BARE_PREFIXES: { test: RegExp; provider: string; creator: string; toGateway?: (id: string) => string }[] = [
  { test: /^claude-/, provider: "anthropic", creator: "anthropic", toGateway: toGatewayClaude },
  { test: /^(gpt-|o\d)/, provider: "openai", creator: "openai" },
  { test: /^gemini-/, provider: "google", creator: "google" },
  { test: /^grok-/, provider: "xai", creator: "spacexai" },
];

/**
 * Pure spec parser. An empty `id` means "that provider's default".
 *   provider:id          explicit, e.g. groq:openai/gpt-oss-120b
 *   provider             a provider's default model, e.g. deepseek
 *   creator/model        gateway, e.g. zai/glm-5.3
 *   claude-* gpt-* gemini-* grok-*   the direct provider if you have its key, else the gateway
 */
export function parseSpec(
  spec: string,
  hasKey: (p: ProviderId) => boolean,
  providers: ProviderDef[] = BUILTIN_PROVIDERS,
): { provider: ProviderId; id: string } {
  const s = spec.trim();
  const known = (p: string) => providers.some((d) => d.id === p);
  const colon = s.indexOf(":");
  if (colon > 0 && !s.slice(0, colon).includes("/")) {
    const provider = s.slice(0, colon);
    const id = s.slice(colon + 1);
    if (!known(provider)) {
      throw new ModelError(`Unknown provider "${provider}". Known: ${providers.map((d) => d.id).join(", ")}.`);
    }
    return { provider, id: provider === "anthropic" ? toAnthropicClaude(id) : id };
  }
  if (known(s)) return { provider: s, id: "" };
  if (s.includes("/")) return { provider: "gateway", id: s };
  for (const b of BARE_PREFIXES) {
    if (!b.test.test(s)) continue;
    if (hasKey(b.provider)) return { provider: b.provider, id: b.provider === "anthropic" ? toAnthropicClaude(s) : s };
    return { provider: "gateway", id: `${b.creator}/${b.toGateway ? b.toGateway(s) : s}` };
  }
  throw new ModelError(`Can't tell which provider "${s}" belongs to. Use provider:id, e.g. gateway:${DEFAULTS.gateway} or groq:${DEFAULTS.groq}.`);
}

const liveCache = new Map<string, Promise<string[] | undefined>>();
/** Live model ids for a provider, cached for the session. `undefined` if the catalog is unreachable. */
export function liveModels(p: ProviderDef, apiKey: string | undefined, ms = 5000): Promise<string[] | undefined> {
  let cached = liveCache.get(p.id);
  if (!cached) {
    cached = fetchModelIds(p, apiKey, ms).catch(() => undefined);
    liveCache.set(p.id, cached);
  }
  return cached;
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

async function keysFor(providers: ProviderDef[]): Promise<Record<ProviderId, string | undefined>> {
  const keys = await Promise.all(providers.map((p) => getKey(p.id)));
  return Object.fromEntries(providers.map((p, i) => [p.id, keys[i]]));
}

/** Catalogs complete enough that an unknown id is almost certainly a typo. */
const STRICT_CATALOGS = new Set(["gateway", "openrouter"]);

/**
 * Resolution order: spec arg (--model) → LEX_MODEL → config.json defaultModel →
 * the first (non-local) provider you have a key for, in registry order.
 */
export async function resolveModel(spec?: string): Promise<ResolvedModel> {
  const providers = await getProviders();
  const keys = await keysFor(providers);
  const chosen = spec || process.env.LEX_MODEL || (await readConfig()).defaultModel;

  let providerId: ProviderId, id: string;
  if (chosen) {
    ({ provider: providerId, id } = parseSpec(chosen, (p) => !!keys[p], providers));
  } else {
    const first = providers.find((p) => !p.local && keys[p.id]);
    if (!first) throw new NoKeyError();
    providerId = first.id;
    id = "";
  }
  const p = providers.find((d) => d.id === providerId)!;
  const apiKey = keys[p.id];
  if (p.env && !apiKey) {
    if (!providers.some((d) => d.env && keys[d.id])) throw new NoKeyError();
    throw new ModelError(`No ${p.id} key. Set ${p.env} or run: ${lexCommand()} login ${p.id}`);
  }

  if (!id) {
    const live = await liveModels(p, apiKey);
    id = p.models.find((m) => live?.includes(m)) ?? p.models[0] ?? live?.[0] ?? "";
    if (!id) {
      throw new ModelError(p.local
        ? `Couldn't reach ${p.label} at ${baseURLOf(p)}. Start it, or set ${p.id.toUpperCase()}_BASE_URL.`
        : `No default model for ${p.id}. Use ${p.id}:<model-id> (see: lex models).`);
    }
  } else if (STRICT_CATALOGS.has(p.id)) {
    const live = await liveModels(p, apiKey);
    if (live && !live.includes(id)) {
      const near = closeMatches(id, live);
      throw new ModelError(`Unknown ${p.id} model "${id}".${near.length ? ` Did you mean:\n  ${near.map((m) => `${p.id}:${m}`).join("\n  ")}` : ""}`);
    }
  }
  return { spec: `${p.id}:${id}`, provider: p.id, id, model: buildModel(p, id, apiKey) };
}

/** A short, curated list for `/model`: each keyed provider's default candidates. */
export async function suggestedModels(): Promise<ModelInfo[]> {
  const providers = await getProviders();
  const keys = await keysFor(providers);
  return providers
    .filter((p) => !p.local && keys[p.id])
    .flatMap((p) => p.models.slice(0, p.id === "gateway" ? 9 : 3).map((id) => ({ spec: `${p.id}:${id}`, provider: p.id, id })));
}

/** Every model your keys (and any running local servers) can reach, from each provider's live catalog. */
export async function listAvailable(): Promise<ModelInfo[]> {
  const providers = await getProviders();
  const keys = await keysFor(providers);
  const usable = providers.filter((p) => p.local || keys[p.id]);
  const lists = await Promise.all(usable.map((p) => liveModels(p, keys[p.id], p.local ? 1500 : 5000)));
  return usable.flatMap((p, i) => {
    const ids = lists[i] ?? (p.local ? [] : p.models);
    return ids.map((id) => ({ spec: `${p.id}:${id}`, provider: p.id, id }));
  });
}
