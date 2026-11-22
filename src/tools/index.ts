import type { Tool } from "ai";
import type { ResolvedModel, ToolContext } from "../types.ts";
import { createReadTool } from "./read.ts";
import { createLsTool } from "./ls.ts";
import { createGrepTool } from "./grep.ts";
import { createWriteTool } from "./write.ts";
import { createEditTool } from "./edit.ts";
import { createBashTool } from "./bash.ts";
import { createTodoTool } from "./todo.ts";
import { createAskUserTool } from "./ask.ts";
import { createRememberTool } from "./remember.ts";
import { createLoadSkillTool } from "./skill.ts";
import { createTaskTool } from "./task.ts";

/**
 * Names of every built-in tool, in the order they are offered to the model.
 * `task` is only built when buildTools gets a model getter (the explorer needs a model).
 */
export const TOOL_NAMES = ["read", "ls", "grep", "write", "edit", "bash", "todo", "ask_user", "remember", "load_skill", "task"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function buildTools(ctx: ToolContext, extras: { getModel?: () => ResolvedModel } = {}): Record<string, Tool> {
  const tools: Record<string, Tool> = {
    read: createReadTool(ctx),
    ls: createLsTool(ctx),
    grep: createGrepTool(ctx),
    write: createWriteTool(ctx),
    edit: createEditTool(ctx),
    bash: createBashTool(ctx),
    todo: createTodoTool(ctx),
    ask_user: createAskUserTool(ctx),
    remember: createRememberTool(ctx),
    load_skill: createLoadSkillTool(ctx),
  };
  if (extras.getModel) tools.task = createTaskTool(ctx, { getModel: extras.getModel });
  return tools;
}
