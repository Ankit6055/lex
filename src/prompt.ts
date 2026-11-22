import path from "node:path";
import type { PromptContext } from "./types.ts";

/** Build the system prompt. Pure: same context in, same string out. Optional sections are omitted when empty. */
export function buildSystemPrompt(ctx: PromptContext): string {
  const has = (name: string) => ctx.toolNames.includes(name);
  const sections: string[] = [];

  // 1. Identity
  const identity = [`You are Lex, a coding agent working in \`${ctx.cwd}\` on ${ctx.os}.`];
  if (ctx.date) identity.push(`Today's date is ${ctx.date}.`);
  if (ctx.gitBranch) identity.push(`Current git branch: ${ctx.gitBranch}.`);
  sections.push(identity.join("\n"));

  // 2. Agency
  sections.push(
    [
      "# Agency",
      "- Act; don't explain what you would do. Do the work with your tools, then summarize briefly.",
      "- Search the codebase before creating anything new; reuse what exists.",
      "- Make the smallest change that solves the task. Match the surrounding style.",
      "- Read a file before editing it.",
      "- After changes, run the project's tests or typecheck if it has them.",
      "- Report results honestly: say what you verified, what failed, and what you didn't check.",
    ].join("\n"),
  );

  // 3. Tools
  const tools = ["# Tools", `Available: ${ctx.toolNames.join(", ")}.`];
  if (has("bash")) tools.push("Prefer read/grep/ls over bash for exploring and reading files.");
  sections.push(tools.join("\n"));

  // 4. Handling ambiguity
  const ambiguity = ["# Handling ambiguity", "1. Search the code and docs first; most answers are already there."];
  if (has("ask_user")) {
    ambiguity.push("2. If it's still unclear and the choice matters, ask with `ask_user` (2-4 concrete options).");
    ambiguity.push("3. Then act on the answer.");
  } else {
    ambiguity.push("2. Otherwise make the most reasonable assumption, state it, and act.");
  }
  sections.push(ambiguity.join("\n"));

  // 5. Planning
  if (has("todo")) {
    sections.push(
      "# Planning\nFor tasks with 3 or more steps, use `todo` to list the steps, keep one in progress, and complete each as you go.",
    );
  }

  // 6. Project instructions
  if (ctx.projectInstructions?.content.trim()) {
    const { file, content } = ctx.projectInstructions;
    const shown = path.isAbsolute(file) ? path.relative(ctx.cwd, file) || path.basename(file) : file;
    sections.push(`# Project instructions\nFrom \`${shown}\`. Follow these:\n\n${content.trim()}`);
  }

  // 7. Memory
  const memory: string[] = [];
  if (ctx.memory?.trim()) memory.push(`Facts saved from earlier sessions:\n${ctx.memory.trim()}`);
  if (has("remember")) {
    memory.push("Use `remember` to save durable facts (commands, conventions, user preferences) for future sessions.");
  }
  if (memory.length) sections.push(["# Memory", ...memory].join("\n"));

  // 8. Skills
  if (ctx.skills?.length) {
    const skills = ["# Skills", ...ctx.skills.map((s) => `- ${s.name}: ${s.description}`)];
    if (has("load_skill")) skills.push("Load a skill's full instructions with `load_skill` when the task matches.");
    sections.push(skills.join("\n"));
  }

  return sections.join("\n\n");
}
