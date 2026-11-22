import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { decodeKeys } from "../src/ui/keys.ts";
import { Composer, type MenuItem } from "../src/ui/composer.ts";
import { ApprovalPanel } from "../src/ui/panels.ts";
import { stripAnsi, truncate, width, wrapPlain } from "../src/ui/text.ts";

const names = (s: string) => decodeKeys(s).map(({ str, key }) => [key.name, key.ctrl && "ctrl", key.meta && "meta", key.shift && "shift", str].filter(Boolean).join(" "));

describe("decodeKeys", () => {
  test("a lone Esc is reported immediately, not merged with the next key", () => {
    expect(names("\x1b")).toEqual(["escape"]);
    expect(names("\x1b\x1b")).toEqual(["escape", "escape"]);
  });
  test("arrows, modifiers, shift+tab, delete and alt+enter", () => {
    expect(names("\x1b[A\x1b[1;3D\x1b[1;5C\x1b[Z\x1b[3~")).toEqual(["up", "left meta", "right ctrl", "tab shift", "delete"]);
    expect(names("\x1b\r")).toEqual(["return meta \r"]);
  });
  test("bracketed paste keeps text and newlines between markers", () => {
    expect(names("\x1b[200~a\rb\x1b[201~")).toEqual(["paste-start", "a a", "return \r", "b b", "paste-end"]);
  });
  test("control keys and UTF-8 text", () => {
    expect(names("\x03\n\x7f")).toEqual(["c ctrl \x03", "enter \n", "backspace"]);
    expect(names("é✓")).toEqual(["é é", "✓ ✓"]);
  });
});

describe("Composer", () => {
  const commands: MenuItem[] = [
    { label: "/model", insert: "/model", run: true },
    { label: "/memory", insert: "/memory", run: true },
    { label: "/remember <fact>", insert: "/remember ", run: false },
  ];
  const make = (history: string[] = []) => {
    const submitted: string[] = [];
    const c = new Composer({
      submit: (s) => submitted.push(s),
      suggest: (before) => {
        const m = before.match(/^\/(\S*)$/);
        return m ? { items: commands.filter((x) => x.insert.slice(1).startsWith(m[1]!)), from: 0 } : null;
      },
    }, history);
    const type = (s: string) => { for (const { str, key } of decodeKeys(s)) c.onKey(str, key); };
    return { c, submitted, type };
  };

  test("typing and enter submits; backslash-enter and alt-enter insert newlines", () => {
    const { c, submitted, type } = make();
    type("line one\\\r");
    expect(c.text).toBe("line one\n");
    type("two\x1b\rthree\r");
    expect(submitted).toEqual(["line one\ntwo\nthree"]);
    expect(c.text).toBe("");
  });

  test("slash menu filters, enter runs a no-arg command, tab completes one that needs an argument", () => {
    const { c, submitted, type } = make();
    type("/me");
    expect(c.menu?.items.map((i) => i.label)).toEqual(["/memory"]);
    type("\r");
    expect(submitted).toEqual(["/memory"]);
    type("/rem\t");
    expect(c.text).toBe("/remember ");
    expect(submitted).toEqual(["/memory"]);
  });

  test("up/down walk history and restore the draft", () => {
    const { c, type } = make(["first", "second"]);
    type("draft");
    type("\x1b[A");
    expect(c.text).toBe("second");
    type("\x1b[A");
    expect(c.text).toBe("first");
    type("\x1b[B\x1b[B");
    expect(c.text).toBe("draft");
  });

  test("ctrl+w deletes a word, ctrl+u clears to line start, pasted newlines don't submit", () => {
    const { c, submitted, type } = make();
    type("hello big world\x17");
    expect(c.text).toBe("hello big ");
    type("\x15");
    expect(c.text).toBe("");
    type("\x1b[200~a\rb\x1b[201~");
    expect(c.text).toBe("a\nb");
    expect(submitted).toEqual([]);
  });

  test("render places the caret on the right row and column", () => {
    const { c, type } = make();
    type("ab\ncd");
    const r = c.render(40, "placeholder");
    expect(r.lines.map(stripAnsi)).toEqual(["─".repeat(39), "❯ ab", "  cd", "─".repeat(39)]);
    expect(r.cursor).toEqual({ row: 2, col: 4 });
  });
});

describe("text helpers", () => {
  test("width ignores ANSI codes and counts wide characters as two columns", () => {
    expect(width("\x1b[31mred\x1b[39m")).toBe(3);
    expect(width("日本")).toBe(4);
  });
  test("truncate cuts to the column limit with an ellipsis", () => {
    expect(stripAnsi(truncate("abcdefgh", 5))).toBe("abcd…");
    expect(truncate("abc", 5)).toBe("abc");
  });
  test("wrapPlain breaks at spaces and reports row start offsets", () => {
    expect(wrapPlain("the quick brown fox", 10)).toEqual([{ text: "the quick ", start: 0 }, { text: "brown fox", start: 10 }]);
  });
});

test("approval dialog: 1/2/3, y/n and esc map to yes / always / no", () => {
  const answer = (keys: string) => {
    let got: string | undefined;
    const p = new ApprovalPanel({ tool: "bash", summary: "npm test", alwaysLabel: 'for "npm test"' }, (v) => (got = v));
    for (const { str, key } of decodeKeys(keys)) p.onKey(str, key);
    return got;
  };
  expect(answer("1")).toBe("y");
  expect(answer("2")).toBe("a");
  expect(answer("3")).toBe("n");
  expect(answer("\x1b")).toBe("n");
  expect(answer("\x1b[B\r")).toBe("a");
});

// ─── End to end: the bundled CLI in a real terminal against a fixture provider ───────────────────

let workspace: string;
let bundle: string;

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "lex-tui-test-"));
  bundle = path.join(workspace, "cli.mjs");
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "../src/cli.ts")], target: "node", outdir: workspace, naming: "cli.mjs" });
  if (!build.success) throw new Error(build.logs.join("\n"));
});

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

function stream(model: string, deltas: object[], finish = "stop") {
  const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model };
  const events = [
    ...deltas.map((delta) => ({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })),
    { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { ...chunk, choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } },
  ];
  const body = [...events.map((e) => JSON.stringify(e)), "[DONE]"].map((e) => `data: ${e}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

test.skipIf(process.platform === "win32")("TUI: approval dialog, esc denies and interrupts, follow-up turn, /exit", async () => {
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json() as { model: string; messages: { role: string; content: unknown }[] };
      requests.push(body);
      if (body.messages.some((m) => m.content === "Follow up")) return stream(body.model, [{ content: "Follow-up succeeded." }]);
      return stream(body.model, [{
        role: "assistant",
        tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "note.txt", content: "Unexpected\n" }) } }],
      }], "tool_calls");
    },
  });
  const home = await mkdtemp(path.join(workspace, "home-"));
  const project = await mkdtemp(path.join(workspace, "project-"));
  await writeFile(path.join(home, "config.json"), JSON.stringify({ defaultModel: "fixture:fixture-model", providers: { fixture: { baseURL: new URL("/v1", server.url).href } } }));
  await writeFile(path.join(project, "note.txt"), "Original\n");

  const steps = [
    { waitFor: /for shortcuts/, send: "Change the note\r" },
    { waitFor: /Do you want to proceed\?[\s\S]*No, and tell lex/, send: "\x1b" },
    { waitFor: /Interrupted/, send: "Follow up\r" },
    { waitFor: /Follow-up succeeded\.[\s\S]*for shortcuts/, send: "/exit\r" },
  ];
  let step = 0, screen = "";
  const decoder = new TextDecoder();
  const child = Bun.spawn(["node", bundle, "--cwd", project], {
    cwd: workspace,
    env: { PATH: process.env.PATH, LEX_HOME: home, NO_COLOR: "1", TMPDIR: workspace },
    timeout: 8000,
    killSignal: "SIGKILL",
    terminal: {
      cols: 100,
      rows: 40,
      data(terminal, bytes) {
        screen += decoder.decode(bytes, { stream: true });
        const next = steps[step];
        if (next?.waitFor.test(stripVTControlCharacters(screen))) {
          step++;
          setTimeout(() => terminal.write(next.send), 50);
        }
      },
    },
  });
  try {
    expect({ code: await child.exited, step }).toEqual({ code: 0, step: steps.length });
    expect(await readFile(path.join(project, "note.txt"), "utf8")).toBe("Original\n");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.messages)).toContain("The user cancelled this request");
    const plain = stripVTControlCharacters(screen);
    expect(plain).toContain("▌ Write file");
    expect(plain).toMatch(/❯ Change the note/);
  } finally {
    child.terminal?.close();
    await server.stop(true);
  }
});
