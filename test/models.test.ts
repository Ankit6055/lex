import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSpec, closeMatches, ModelError } from "../src/models.ts";
import { getKey, saveKey, redact } from "../src/auth.ts";
import { formatFooter } from "../src/render.ts";

const none = () => false;
const all = () => true;

describe("parseSpec", () => {
  test("explicit provider:id", () => {
    expect(parseSpec("gateway:openai/gpt-6.2-sol", none)).toEqual({ provider: "gateway", id: "openai/gpt-6.2-sol" });
    expect(parseSpec("openai:gpt-6.2-sol", none)).toEqual({ provider: "openai", id: "gpt-6.2-sol" });
    expect(parseSpec("anthropic:claude-opus-5-5", none)).toEqual({ provider: "anthropic", id: "claude-opus-5-5" });
  });
  test("anthropic direct normalizes dotted versions to dashes", () => {
    expect(parseSpec("anthropic:claude-opus-5.5", none).id).toBe("claude-opus-5-5");
  });
  test("bare id with / goes to the gateway", () => {
    expect(parseSpec("zai/glm-5.3", all)).toEqual({ provider: "gateway", id: "zai/glm-5.3" });
  });
  test("bare claude-* goes direct with a key, else gateway with dotted id", () => {
    expect(parseSpec("claude-sonnet-5-5", all)).toEqual({ provider: "anthropic", id: "claude-sonnet-5-5" });
    expect(parseSpec("claude-sonnet-5-5", none)).toEqual({ provider: "gateway", id: "anthropic/claude-sonnet-5.5" });
  });
  test("bare gpt-* goes direct with a key, else gateway", () => {
    expect(parseSpec("gpt-6.2-sol", all)).toEqual({ provider: "openai", id: "gpt-6.2-sol" });
    expect(parseSpec("gpt-6.2-sol", none)).toEqual({ provider: "gateway", id: "openai/gpt-6.2-sol" });
  });
  test("bad specs throw ModelError with guidance", () => {
    expect(() => parseSpec("gogle:gemini", all)).toThrow(ModelError);
    expect(() => parseSpec("gateway:", all)).toThrow(/Missing model id/);
    expect(() => parseSpec("sonnet", all)).toThrow(/provider:id/);
  });
});

test("closeMatches ranks substring hits and near misses first", () => {
  const ids = ["anthropic/claude-sonnet-5.5", "openai/gpt-6.2-sol", "zai/glm-5.3"];
  expect(closeMatches("anthropic/claude-sonet-5.5", ids)[0]).toBe("anthropic/claude-sonnet-5.5");
  expect(closeMatches("glm", ids)[0]).toBe("zai/glm-5.3");
});

describe("auth", () => {
  let home: string;
  const saved = { ...process.env };
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "lex-auth-"));
    process.env.LEXCODE_HOME = home;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(async () => {
    process.env = { ...saved };
    await rm(home, { recursive: true, force: true });
  });

  test("saveKey writes auth.json with mode 0600 and getKey reads it", async () => {
    await saveKey("openai", "  sk-test-123  ");
    const file = path.join(home, "auth.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ openai: { type: "api_key", key: "sk-test-123" } });
    expect(await getKey("openai")).toBe("sk-test-123");
    expect(await getKey("anthropic")).toBeUndefined();
  });
  test("env var wins over auth.json", async () => {
    await saveKey("gateway", "from-file");
    process.env.AI_GATEWAY_API_KEY = "from-env";
    expect(await getKey("gateway")).toBe("from-env");
  });
});

test("redact hides key-shaped strings", () => {
  const s = redact('failed: vck_abcdefghijklmnop and sk-ant-api03-xyzxyzxyzxyz "authorization": "Bearer abc.def"');
  expect(s).not.toContain("abcdefghijklmnop");
  expect(s).not.toContain("xyzxyzxyzxyz");
  expect(s).not.toContain("abc.def");
});

test("formatFooter", () => {
  expect(formatFooter({ steps: 4, toolCalls: 3, inputTokens: 12300, outputTokens: 800, ms: 9100 }, "anthropic:claude-sonnet-5-5"))
    .toBe("4 steps · 12.3k in / 800 out · 9.1s · anthropic:claude-sonnet-5-5");
});
