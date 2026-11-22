import { tool, type Tool } from "ai";
import { z } from "zod";
import type { ToolFactory } from "../types.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem {
  id: number;
  description: string;
  status: TodoStatus;
}

/** Each todo tool instance owns its list; the REPL reads it back through `getTodoList(tool)`. */
const lists = new WeakMap<Tool, TodoItem[]>();

/** The current items of a todo tool created by `createTodoTool` (empty for any other tool). */
export function getTodoList(t: Tool): readonly TodoItem[] {
  return lists.get(t) ?? [];
}

/** Render items as a checklist: `[ ] #1 pending`, `[~] #2 in progress`, `[x] #3 done`. */
export function renderTodos(items: readonly TodoItem[]): string {
  if (items.length === 0) return "(no todos yet)";
  const done = items.filter((i) => i.status === "completed").length;
  const mark = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
  const lines = items.map((i) => `${mark[i.status]} #${i.id} ${i.description}`);
  return `Todos (${done}/${items.length} done):\n${lines.join("\n")}`;
}

const DESCRIPTION = `Track a short plan for multi-step work as a checklist the user can see. Actions: add, start, complete, list.

WHEN TO USE:
- A task has 3 or more distinct steps (e.g. "add an endpoint, write tests, update docs").
- Before starting each step (\`start\`) and right after finishing it (\`complete\`), so progress stays visible.
- The user gives you several things to do at once.

WHEN NOT TO USE:
- Single-step or trivial requests (one edit, one question); just do them.
- Recording facts for future sessions: use \`remember\`.

DO NOT USE FOR:
- Asking the user anything: use \`ask_user\`.
- Having more than one item in progress: only one item can be in_progress at a time. Complete the current one before starting another.

EXAMPLES:
- {"action": "add", "description": "Add /health route"}
- {"action": "start", "id": 1}
- {"action": "complete", "id": 1}
- {"action": "list"}`;

export const createTodoTool: ToolFactory = (_ctx) => {
  const items: TodoItem[] = [];
  let nextId = 1;

  const withList = (msg: string) => `${msg}\n${renderTodos(items)}`;
  const find = (id: number | undefined) => (id === undefined ? undefined : items.find((i) => i.id === id));

  const t = tool({
    description: DESCRIPTION,
    inputSchema: z.object({
      action: z.enum(["add", "start", "complete", "list"]),
      description: z.string().optional().describe("Required for add: what the step is."),
      id: z.number().int().optional().describe("Required for start and complete: the item's #id."),
    }),
    execute: async ({ action, description, id }) => {
      try {
        switch (action) {
          case "add": {
            const desc = description?.trim();
            if (!desc) return withList("Error: add needs a description.");
            const item: TodoItem = { id: nextId++, description: desc, status: "pending" };
            items.push(item);
            return withList(`Added #${item.id}.`);
          }
          case "start": {
            const item = find(id);
            if (!item) return withList(`Error: no todo with id ${id ?? "(missing)"}. start needs an existing id.`);
            if (item.status === "in_progress") return withList(`#${item.id} is already in progress.`);
            if (item.status === "completed") return withList(`Error: #${item.id} is already completed.`);
            const active = items.find((i) => i.status === "in_progress");
            if (active) {
              return withList(
                `Error: #${active.id} "${active.description}" is already in progress. Only one item can be in progress at a time so the user can see exactly what you are doing; complete #${active.id} first, then start #${item.id}.`,
              );
            }
            item.status = "in_progress";
            return withList(`Started #${item.id}.`);
          }
          case "complete": {
            const item = find(id);
            if (!item) return withList(`Error: no todo with id ${id ?? "(missing)"}. complete needs an existing id.`);
            if (item.status === "completed") return withList(`#${item.id} was already completed.`);
            item.status = "completed";
            return withList(`Completed #${item.id}.`);
          }
          case "list":
            return renderTodos(items);
        }
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });
  lists.set(t, items);
  return t;
};
