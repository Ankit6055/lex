import { tool } from "ai";
import { z } from "zod";
import type { ToolFactory } from "../types.ts";

const DESCRIPTION = `Ask the user a multiple-choice question and wait for their answer. They can pick an option or type their own reply.

WHEN TO USE:
- The request is ambiguous and the choice changes what you build (e.g. which file, which library, which behavior).
- You are about to do something risky or hard to undo and want an explicit decision.
- A previous action was denied and you need to know how to proceed.

WHEN NOT TO USE:
- You can find the answer yourself with read, ls, grep or bash.
- The answer doesn't change your next step; pick a sensible default and mention it.

DO NOT USE FOR:
- Approving commands or file changes; bash, write and edit already ask the user.
- Open-ended chat; ask a focused question with 2 to 4 concrete options.

EXAMPLES:
- {"question": "Which test runner should I use?", "options": ["bun test", "vitest"]}
- {"question": "The build is failing on main too. What now?", "options": ["Fix it", "Ignore it", "Stop here"]}`;

export const createAskUserTool: ToolFactory = (ctx) =>
  tool({
    description: DESCRIPTION,
    inputSchema: z.object({
      question: z.string().describe("One short, specific question."),
      options: z.array(z.string()).min(2).max(4).describe("2 to 4 concrete answers the user can pick from."),
    }),
    execute: async ({ question, options }) => {
      try {
        const answer = await ctx.io.withPaused(() => ctx.io.choose(question, options));
        const a = answer.trim();
        return a || "The user did not answer.";
      } catch (err) {
        return `Error: could not ask the user: ${(err as Error).message}. Do not retry denied actions. Finish now: summarize what you found and what you would do with approval.`;
      }
    },
  });
