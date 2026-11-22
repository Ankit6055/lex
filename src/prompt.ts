import path from "node:path";
import type { PromptContext } from "./types.ts";

/**
 * Build the system prompt. Pure: same context in, same string out.
 * Kept deliberately short (every token here is paid on every step): one identity line, a few
 * rules that only mention tools that exist, then tagged context sections that are omitted when empty.
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const has = (name: string) => ctx.toolNames.includes(name);
  const rules = [
    "Read a file before editing it. Make the smallest change that works and match the surrounding style.",
    has("bash") && "Use read/ls/grep for files and bash for everything else.",
    "After changing code, run the project's tests or type check if it has them. Report what you verified.",
    has("todo") && "Track tasks with 3 or more steps with todo.",
    has("task") && "Delegate broad, read-heavy questions to task to keep your context small.",
    has("ask_user") && "If you're blocked on a decision that matters, ask with ask_user; otherwise pick a sensible default.",
    has("remember") && "Save durable facts (commands, conventions, preferences) with remember.",
    "Be concise. Show file paths clearly.",
  ].filter(Boolean);

  const sections = [
    "You are lex, a coding agent. Help the user inspect files, run commands and change code.",
    rules.map((r) => `- ${r}`).join("\n"),
    `<env>\ncwd: ${ctx.cwd}\nos: ${ctx.os}${ctx.date ? `\ndate: ${ctx.date}` : ""}${ctx.gitBranch ? `\ngit branch: ${ctx.gitBranch}` : ""}\n</env>`,
  ];

  if (ctx.projectInstructions?.content.trim()) {
    const { file, content } = ctx.projectInstructions;
    const shown = path.isAbsolute(file) ? path.relative(ctx.cwd, file) || path.basename(file) : file;
    sections.push(`<project_instructions path="${shown}">\n${content.trim()}\n</project_instructions>`);
  }
  if (ctx.memory?.trim()) sections.push(`<memory>\n${ctx.memory.trim()}\n</memory>`);
  if (ctx.skills?.length) {
    const hint = has("load_skill") ? "\nLoad a skill with load_skill when it fits the task." : "";
    sections.push(`<skills>\n${ctx.skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}\n</skills>${hint}`);
  }
  return sections.join("\n\n");
}
