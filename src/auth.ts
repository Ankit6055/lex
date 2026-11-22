// Bring-your-own-key storage. Env vars win; otherwise ~/.lex/auth.json (mode 0600).
// Keys never leave this module except as the explicit `apiKey` handed to a provider.
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { IO, ProviderId } from "./types.ts";

export const PROVIDERS: ProviderId[] = ["gateway", "anthropic", "openai"];

export const ENV_VARS: Record<ProviderId, string> = {
  gateway: "AI_GATEWAY_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

const LABELS: Record<ProviderId, string> = {
  gateway: "Vercel AI Gateway (recommended: one key, every model)",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

type AuthFile = Partial<Record<ProviderId, { type: "api_key"; key: string }>>;

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
export async function readConfig(): Promise<{ defaultModel?: string }> {
  return (await readJson(path.join(configDir(), "config.json"))) ?? {};
}

export async function getKey(p: ProviderId): Promise<string | undefined> {
  const env = process.env[ENV_VARS[p]]?.trim();
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
  const choice = await io.choose("Which provider?", PROVIDERS.map((p) => LABELS[p]));
  const provider = PROVIDERS.find((p) => LABELS[p] === choice) ?? PROVIDERS.find((p) => choice.toLowerCase().includes(p));
  if (!provider) throw new Error(`Unknown provider: ${choice}`);
  const key = (await io.secret(`Paste your ${ENV_VARS[provider]}: `)).trim();
  if (!key) throw new Error("No key entered; nothing saved.");
  await saveKey(provider, key);
  io.info(`Saved ${provider} key to ${authPath()} (chmod 600).`);
}

/** Strip anything key-shaped from text we might print (provider errors can echo headers). */
export function redact(s: string): string {
  return s
    .replace(/\b(vck_|sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{8,}/g, "$1***")
    .replace(/(authorization|x-api-key)(["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',}]+/gi, "$1$2$3***");
}
