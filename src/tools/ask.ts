import { tool } from "ai";
import { z } from "zod";
import type { ToolFactory } from "../types.ts";

const DESCRIPTION = `Ask the user a question with 2-4 options and wait for the answer. Only when blocked on a decision that matters.`;

export const createAskUserTool: ToolFactory = (ctx) =>
  tool({
    description: DESCRIPTION,
    inputSchema: z.object({
      question: z.string().describe("The question"),
      options: z.array(z.string()).min(2).max(4).describe("2-4 answers to choose from"),
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
