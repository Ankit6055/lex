import type { Tool } from "ai";
import type { ToolContext } from "../types.ts";
import { createReadTool } from "./read.ts";
import { createLsTool } from "./ls.ts";
import { createGrepTool } from "./grep.ts";
import { createWriteTool } from "./write.ts";
import { createEditTool } from "./edit.ts";
import { createBashTool } from "./bash.ts";
import { createTodoTool } from "./todo.ts";
import { createAskUserTool } from "./ask.ts";
import { createRememberTool } from "./remember.ts";

/** Names of every built-in tool, in the order they are offered to the model. */
export const TOOL_NAMES = ["read", "ls", "grep", "write", "edit", "bash", "todo", "ask_user", "remember"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function buildTools(ctx: ToolContext): Record<string, Tool> {
  return {
    read: createReadTool(ctx),
    ls: createLsTool(ctx),
    grep: createGrepTool(ctx),
    write: createWriteTool(ctx),
    edit: createEditTool(ctx),
    bash: createBashTool(ctx),
    todo: createTodoTool(ctx),
    ask_user: createAskUserTool(ctx),
    remember: createRememberTool(ctx),
  };
}
