// Bring-your-own-key storage. Env vars win; otherwise ~/.lex/auth.json (mode 0600).
// Keys never leave this module except as the explicit `apiKey` handed to a provider.
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { IO, ProviderId } from "./types.ts";
import { allProviders, type CustomProviderConfig, type ProviderDef } from "./providers.ts";

type AuthFile = Record<ProviderId, { type: "api_key"; key: string }>;

export interface LexConfig {
  defaultModel?: string;
  /** Extra OpenAI-compatible endpoints, e.g. { "vllm": { "baseURL": "http://box:8000/v1", "models": ["qwen3"] } } */
  providers?: Record<string, CustomProviderConfig>;
}

/** ~/.lex, overridable with LEX_HOME (used by tests). */
export function configDir(): string {
  return process.env.LEX_HOME || path.join(homedir(), ".lex");
}
const authPath = () => path.join(configDir(), "auth.json");

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Reads ~/.lex/config.json (e.g. `{ "defaultModel": "gateway:openai/gpt-6.2-sol" }`). */
export async function readConfig(): Promise<LexConfig> {
  return (await readJson<LexConfig>(path.join(configDir(), "config.json"))) ?? {};
}

/** Merge `patch` into ~/.lex/config.json (e.g. the model you last picked, so it's the default next time). */
export async function saveConfig(patch: Partial<LexConfig>): Promise<void> {
  const file = path.join(configDir(), "config.json");
  const current = (await readJson<LexConfig>(file)) ?? {};
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ ...current, ...patch }, null, 2) + "\n");
}

/** Every provider: built-ins plus custom ones from config.json. */
export async function getProviders(): Promise<ProviderDef[]> {
  return allProviders((await readConfig()).providers);
}

export async function getKey(p: ProviderId): Promise<string | undefined> {
  const def = (await getProviders()).find((d) => d.id === p);
  const env = def?.env ? process.env[def.env]?.trim() : undefined;
  if (env) return env;
  const file = await readJson<AuthFile>(authPath());
  return file?.[p]?.key || undefined;
}

export async function saveKey(p: ProviderId, key: string): Promise<void> {
  const dir = configDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = (await readJson<AuthFile>(authPath())) ?? {};
  file[p] = { type: "api_key", key: key.trim() };
  await writeFile(authPath(), JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  await chmod(authPath(), 0o600); // writeFile's mode only applies on create
}

export async function login(io: IO): Promise<void> {
  const keyed = (await getProviders()).filter((p) => p.env);
  const label = (p: ProviderDef) => `${p.label} (${p.id})`;
  const choice = await io.choose("Which provider?", keyed.map(label));
  const c = choice.trim().toLowerCase();
  const provider = keyed.find((p) => label(p) === choice) ?? keyed.find((p) => p.id === c) ?? keyed.find((p) => c.includes(p.id));
  if (!provider) throw new Error(`Unknown provider: ${choice}`);
  const key = (await io.secret(`Paste your ${provider.env}: `)).trim();
  if (!key) throw new Error("No key entered; nothing saved.");
  await saveKey(provider.id, key);
  io.info(`Saved ${provider.id} key to ${authPath()} (chmod 600).`);
}

/** Strip anything key-shaped from text we might print (provider errors can echo headers). */
export function redact(s: string): string {
  return s
    .replace(/\b(vck_|sk-ant-|sk-proj-|sk-or-v1-|sk-|xai-|gsk_|hf_|nvapi-|fw_|csk-)[A-Za-z0-9_-]{8,}/g, "$1***")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza***")
    .replace(/(authorization|x-api-key|x-goog-api-key)(["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',}]+/gi, "$1$2$3***");
}
