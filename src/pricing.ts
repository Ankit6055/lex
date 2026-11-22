// Cost estimates from the AI Gateway's public model catalog (per-token USD prices).
// Direct-provider specs are mapped onto gateway ids; local models cost nothing.
import { BUILTIN_PROVIDERS } from "./providers.ts";

export interface Price { input: number; output: number; cacheRead?: number }

const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";

/** Gateway creator for each direct provider whose model ids match the gateway's. */
const CREATOR: Record<string, string> = {
  anthropic: "anthropic", openai: "openai", google: "google", xai: "spacexai",
  deepseek: "deepseek", mistral: "mistral", moonshot: "moonshotai", zai: "zai", minimax: "minimax",
};

type Catalog = { data?: { id: string; pricing?: { input?: string; output?: string; input_cache_read?: string } }[] };

let catalog: Promise<Map<string, Price>> | undefined;

/** Load prices once per process. Resolves to an empty map if the catalog can't be reached. */
export function loadPrices(): Promise<Map<string, Price>> {
  catalog ??= fetch(CATALOG_URL, { signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? (r.json() as Promise<Catalog>) : ({ data: [] } as Catalog)))
    .then((body) => {
      const map = new Map<string, Price>();
      for (const m of body.data ?? []) {
        const input = Number(m.pricing?.input), output = Number(m.pricing?.output);
        if (Number.isFinite(input) && Number.isFinite(output)) {
          map.set(m.id, { input, output, cacheRead: m.pricing?.input_cache_read ? Number(m.pricing.input_cache_read) : undefined });
        }
      }
      return map;
    })
    .catch(() => new Map());
  return catalog;
}

/** The gateway id a spec is priced as, "local" for free local models, or undefined if unknown. */
export function priceKey(spec: string, localProviders: Set<string> = new Set(BUILTIN_PROVIDERS.filter((p) => p.local).map((p) => p.id))): string | undefined {
  const colon = spec.indexOf(":");
  const provider = spec.slice(0, colon), id = spec.slice(colon + 1);
  if (localProviders.has(provider)) return "local";
  if (provider === "gateway" || provider === "openrouter") return id;
  const creator = CREATOR[provider];
  if (!creator) return undefined;
  return `${creator}/${provider === "anthropic" ? id.replace(/-(\d+)-(\d+)$/, "-$1.$2") : id}`;
}

/** Estimated USD cost for a model's token usage, or undefined if the model has no known price. */
export function estimateCost(
  prices: Map<string, Price>,
  spec: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
  localProviders?: Set<string>,
): number | undefined {
  const key = priceKey(spec, localProviders);
  if (key === "local") return 0;
  const p = key ? prices.get(key) : undefined;
  if (!p) return undefined;
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  return (usage.inputTokens - cached) * p.input + cached * (p.cacheRead ?? p.input) + usage.outputTokens * p.output;
}

export function formatCost(usd: number | undefined): string {
  if (usd === undefined) return "—";
  if (usd === 0) return "$0";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`;
}
