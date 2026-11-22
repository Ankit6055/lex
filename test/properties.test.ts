import { expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import fc from "fast-check";
import { contextFor, dropDanglingToolCalls } from "../src/agent.ts";
import { parseSpec } from "../src/models.ts";
import { serialize } from "../src/util/serialize.ts";
import { capChars, capLines, capTail } from "../src/util/truncate.ts";

const options = { numRuns: 500 };
const text = fc.string({ unit: "binary", maxLength: 80 });
const modelToken = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/);

test("explicit compatible-provider model specs preserve namespaced IDs and tags", () => {
  fc.assert(fc.property(
    fc.constantFrom("ollama", "groq", "openrouter"), modelToken, modelToken, modelToken, fc.boolean(),
    (provider, namespace, model, tag, hasKey) => {
      const id = `${namespace}/${model}:${tag}`;
      expect(parseSpec(`  ${provider}:${id}  `, () => hasKey)).toEqual({ provider, id });
    },
  ), options);
});

test("character caps keep exact prefixes and suffixes even for multiline Unicode", () => {
  const multiline = fc.array(text, { minLength: 1, maxLength: 4 }).map((lines) => lines.join("\n"));
  fc.assert(fc.property(multiline, fc.nat(120), (source, limit) => {
    if (source.length <= limit) {
      expect(capChars(source, limit)).toBe(source);
      expect(capTail(source, limit)).toBe(source);
      return;
    }
    expect(capChars(source, limit)).toBe(
      `${source.slice(0, limit)}\n[truncated: showing first ${limit} of ${source.length} chars]`,
    );
    expect(capTail(source, limit)).toBe(
      `[truncated: showing last ${limit} of ${source.length} chars]\n${limit ? source.slice(-limit) : ""}`,
    );
  }), options);
});

test("line truncation preserves blank lines and reports the original count", () => {
  const line = fc.oneof(fc.constant(""), text.map((value) => value.replaceAll("\n", "")));
  fc.assert(fc.property(fc.array(line, { minLength: 1, maxLength: 20 }), fc.nat(25), (lines, limit) => {
    const source = lines.join("\n");
    const capped = capLines(source, limit, "Read the next page");
    if (lines.length <= limit) {
      expect(capped).toBe(source);
      return;
    }
    const output = capped.split("\n");
    expect(output.pop()).toBe(`[truncated: showing ${limit} of ${lines.length} lines. Read the next page]`);
    expect(output.join("\n")).toBe(lines.slice(0, limit).join("\n"));
  }), options);
});

function readCall(toolCallId: string) {
  return { type: "tool-call", toolCallId, toolName: "read", input: { path: "note.txt" } } as const;
}

function readResult(toolCallId: string, value: string) {
  return { type: "tool-result", toolCallId, toolName: "read", output: { type: "text", value } } as const;
}

test("tool-call cleanup keeps completed pairs in order and is idempotent", () => {
  fc.assert(fc.property(fc.array(fc.boolean(), { maxLength: 20 }), fc.option(text), (completed, note) => {
    const calls = completed.map((_, index) => readCall(`read-${index}`));
    const finished = calls.filter((_, index) => completed[index]);
    const explanation = note === null ? [] : [{ type: "text" as const, text: note }];
    const results = finished.map(({ toolCallId }) => readResult(toolCallId, `result for ${toolCallId}`));
    const user: ModelMessage = { role: "user", content: "Read the notes." };
    const resultMessages: ModelMessage[] = results.length ? [{ role: "tool", content: results }] : [];
    const input: ModelMessage[] = [user, { role: "assistant", content: [...explanation, ...calls] }, ...resultMessages];
    const expected: ModelMessage[] = [user];
    if (explanation.length || finished.length) expected.push({ role: "assistant", content: [...explanation, ...finished] });
    expected.push(...resultMessages);
    const original = structuredClone(input);

    const cleaned = dropDanglingToolCalls(input);
    expect(cleaned).toEqual(expected);
    expect(dropDanglingToolCalls(cleaned)).toEqual(cleaned);
    expect(input).toEqual(original);
  }), options);
});

test("context pruning keeps prior conversation text, notes each prior tool call in one line, and keeps the small current turn whole", () => {
  const messageText = fc.string({ unit: "binary", minLength: 1, maxLength: 80 });
  const earlierTurns = fc.array(fc.tuple(messageText, messageText), { maxLength: 12 });
  fc.assert(fc.property(earlierTurns, text, (turns, currentOutput) => {
    const conversation: ModelMessage[] = [];
    const history: ModelMessage[] = [];
    turns.forEach(([question, answer], index) => {
      const id = `prior-${index}`;
      const user: ModelMessage = { role: "user", content: question };
      const assistant: ModelMessage = { role: "assistant", content: [{ type: "text", text: answer }] };
      // The tool call and its full result collapse into a one-line note the model can still see.
      const note: ModelMessage = { role: "assistant", content: [{ type: "text", text: "[read note.txt → old file body]" }] };
      conversation.push(user, note, assistant);
      history.push(user, { role: "assistant", content: [readCall(id)] },
        { role: "tool", content: [readResult(id, "old file body")] }, assistant);
    });
    const currentUser: ModelMessage = { role: "user", content: "Read the current note." };
    history.push(currentUser);
    const current: ModelMessage[] = [
      { role: "assistant", content: [readCall("current")] },
      { role: "tool", content: [readResult("current", currentOutput)] },
    ];
    expect(contextFor(history, current)).toEqual([...conversation, currentUser, ...current]);
  }), options);
});

test("serialized work runs in submission order with no overlap and survives failures", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }), async (failures) => {
    const events: string[] = [];
    const error = new Error("mutation failed");
    const results = await Promise.allSettled(failures.map((shouldFail, index) => serialize(async () => {
      events.push(`start ${index}`);
      await Promise.resolve();
      events.push(`finish ${index}`);
      if (shouldFail) throw error;
      return index;
    })));

    expect(events).toEqual(failures.flatMap((_, index) => [`start ${index}`, `finish ${index}`]));
    expect(results).toEqual(failures.map((shouldFail, index) => shouldFail
      ? { status: "rejected", reason: error }
      : { status: "fulfilled", value: index }));
  }), options);
});
