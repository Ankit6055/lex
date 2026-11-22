import { test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import type { IO } from "../src/types.ts";
import { createApprover } from "../src/approval.ts";
import { dropDanglingToolCalls, contextFor } from "../src/agent.ts";

test("approval prompts from parallel tool calls are shown one at a time", async () => {
  let active = 0, maxActive = 0;
  const asked: string[] = [];
  const io: IO = {
    async confirm(q) {
      active++; maxActive = Math.max(maxActive, active);
      asked.push(q);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return "y";
    },
    async choose() { return ""; },
    async prompt() { return null; },
    async secret() { return ""; },
    withPaused: (fn) => fn(),
    info() {},
  };
  const approver = createApprover(io, "ask");
  const results = await Promise.all([
    approver.request({ tool: "bash", summary: "sleep 1", alwaysKey: "bash:sleep 1" }),
    approver.request({ tool: "bash", summary: "sleep 2", alwaysKey: "bash:sleep 2" }),
  ]);
  expect(results).toEqual(["allow", "allow"]);
  expect(maxActive).toBe(1);
  expect(asked[0]).toContain("sleep 1");
  expect(asked[1]).toContain("sleep 2");
});

test("dropDanglingToolCalls removes tool calls without results and empty messages", () => {
  const msgs: ModelMessage[] = [
    { role: "assistant", content: [
      { type: "text", text: "running" },
      { type: "tool-call", toolCallId: "a", toolName: "bash", input: {} },
      { type: "tool-call", toolCallId: "b", toolName: "bash", input: {} },
    ] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "a", toolName: "bash", output: { type: "text", value: "ok" } }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "read", input: {} }] },
  ];
  const out = dropDanglingToolCalls(msgs);
  expect(out).toHaveLength(2);
  const first = out[0]!;
  expect(first.role === "assistant" && Array.isArray(first.content) && first.content.map((p) => p.type)).toEqual(["text", "tool-call"]);
});

test("contextFor drops tool bodies from earlier turns but keeps the current turn intact", () => {
  const call = (id: string) => ({ role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: id, toolName: "read", input: { path: "a" } }] });
  const result = (id: string) => ({ role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: id, toolName: "read", output: { type: "text" as const, value: "file body" } }] });
  const history: ModelMessage[] = [
    { role: "user", content: "first question" }, call("old"), result("old"), { role: "assistant", content: "old answer" },
    { role: "user", content: "second question" },
  ];
  const turn: ModelMessage[] = [call("a"), result("a"), call("b"), result("b"), call("c"), result("c")];
  const out = contextFor(history, turn);
  const json = JSON.stringify(out);
  expect(json).not.toContain('"old"');           // earlier turn's tool call and result are gone
  expect(json).toContain("old answer");          // but its conversation text stays
  for (const id of ["a", "b", "c"]) expect(json).toContain(`"toolCallId":"${id}"`); // current turn fully kept
  expect(out.slice(-turn.length)).toEqual(turn);
});
