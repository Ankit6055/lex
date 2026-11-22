import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { callLabel, createRenderer, resultSuffix } from "../src/render.ts";

describe("terminal labels and summaries", () => {
  test("collapses whitespace in quoted labels and bounds their length", () => {
    expect(callLabel("grep", { pattern: "  two\n  words\t", path: "src" })).toBe('grep "two words" in src');
    expect(callLabel("task", { description: "a".repeat(45) })).toBe(`task "${"a".repeat(39)}…"`);
    expect(callLabel("bash", { command: "pwd\nls" })).toBe("bash pwd");
  });

  test("counts returned file lines and uses grep's total when results are truncated", () => {
    expect(resultSuffix("read", {}, "10\tfirst\n11\tsecond\n\n[truncated: use offset]")).toBe(" (2 lines)");
    expect(resultSuffix("grep", {}, "src/a.ts:3: hit\nsrc/b.ts:7: hit")).toBe(" → 2 matches");
    expect(resultSuffix("grep", {}, "src/a.ts:3: hit\n[truncated: 72 total matches]")).toBe(" → 72 matches");
  });

  test("reports denials and errors in place of success counts", () => {
    const input = { content: "first\nsecond" };
    expect(stripVTControlCharacters(resultSuffix("write", input, "User denied this action."))).toBe(" (denied)");
    expect(stripVTControlCharacters(resultSuffix("write", input, "Error: read-only session"))).toBe(" (read-only)");
    expect(stripVTControlCharacters(resultSuffix("write", input, "Error: disk full\nextra details"))).toBe(" ✗ Error: disk full");
  });

  test("uses the edit tool's actual diff totals across all replacements", () => {
    const input = { old_string: "before", new_string: "after\nextra", replace_all: true };
    expect(resultSuffix("edit", input, "Edited notes.txt: replaced 3 occurrences (+6 −3).")).toBe(" (+6 −3)");
    expect(resultSuffix("edit", input, "Edited notes.txt.")).toBe(" (+2 −1)");
  });
});

describe("createRenderer", () => {
  function capture() {
    let stdout = "";
    let stderr = "";
    const spinnerCalls: string[] = [];
    const out = new Writable({
      write(chunk, _encoding, done) {
        stdout += chunk.toString();
        done();
      },
    });
    const renderer = createRenderer({
      out,
      writeErr: (message) => { stderr += stripVTControlCharacters(message); },
      spinner: {
        start: (label) => { spinnerCalls.push(label); },
        stop: () => { spinnerCalls.push("stop"); },
      },
    });
    return { renderer, spinnerCalls, stdout: () => stdout, stderr: () => stderr };
  }

  test("streams model text to stdout and pairs parallel tool results by call ID", () => {
    const { renderer, stdout, stderr } = capture();
    renderer.onChunk({ type: "text-delta", id: "text-1", text: "Checking" });
    renderer.onChunk({ type: "tool-call", toolCallId: "a", toolName: "read", input: { path: "a.txt" } });
    renderer.onChunk({ type: "tool-call", toolCallId: "b", toolName: "read", input: { path: "b.txt" } });
    renderer.onChunk({ type: "tool-result", toolCallId: "b", toolName: "read", input: {}, output: "1\tsecond" });
    renderer.onChunk({ type: "tool-result", toolCallId: "a", toolName: "read", input: {}, output: "1\tfirst\n2\tsecond" });
    renderer.onChunk({ type: "text-delta", id: "text-2", text: "Done" });
    renderer.footer({ steps: 1, toolCalls: 2, inputTokens: 30, outputTokens: 10, ms: 900 }, "test:model");

    expect(stdout()).toBe("Checking\nDone\n");
    expect(stderr()).toBe("● read b.txt (1 lines)\n● read a.txt (2 lines)\n1 step · 30 in / 10 out · 0.9s · test:model\n");
  });

  test("stops the spinner and completes the partial text line when a turn aborts", () => {
    const { renderer, stdout, stderr, spinnerCalls } = capture();
    renderer.onChunk({ type: "text-delta", id: "text-1", text: "Partial" });
    renderer.onChunk({ type: "abort" });

    expect(stdout()).toBe("Partial\n");
    expect(stderr()).toBe("(aborted)\n");
    expect(spinnerCalls).toEqual(["stop", "stop"]);
  });

  test("defers tool output and suppresses spinner draws while a terminal prompt waits", async () => {
    const script = `
      import { createRenderer } from ${JSON.stringify(import.meta.resolve("../src/render.ts"))};
      import { closeIO, createIO, isSpinning, startSpinner, stopSpinner, writeWhenIdle }
        from ${JSON.stringify(import.meta.resolve("../src/io.ts"))};

      Object.defineProperty(process.stderr, "isTTY", { value: true });
      const io = createIO();
      const renderer = createRenderer({ spinner: { start: startSpinner, stop: stopSpinner }, writeErr: writeWhenIdle });
      try {
        startSpinner("before prompt");
        const answer = await io.withPaused(async () => {
          const pending = io.prompt("Your answer? ");
          renderer.onChunk({ type: "tool-call", toolCallId: "a", toolName: "read", input: { path: "a.txt" } });
          renderer.onChunk({ type: "tool-result", toolCallId: "a", toolName: "read", input: {}, output: "1\\tline" });
          if (isSpinning()) throw new Error("spinner drew during the prompt");
          process.stderr.write("[prompt still waiting]\\n");
          return pending;
        });
        if (!isSpinning()) throw new Error("spinner did not resume after the prompt");
        console.log(answer);
      } finally {
        closeIO();
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      stdin: new Blob(["yes\n"]),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 3000,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect({ exitCode, stdout }).toEqual({ exitCode: 0, stdout: "yes\n" });
    expect(stripVTControlCharacters(stderr)).toContain("Your answer? [prompt still waiting]\n● read a.txt (1 lines)\n");
  });
});
