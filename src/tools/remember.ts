import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { ToolFactory } from "../types.ts";

export const MEMORY_MAX_CHARS = 4_000;
const FACT_MAX_CHARS = 500;

const DESCRIPTION = `Save one durable fact about this project or the user's preferences to .lex/memory.md, which is loaded into future sessions.

WHEN TO USE:
- The user states a lasting preference ("always use pnpm", "never touch generated/").
- You discover a non-obvious project fact worth knowing next time (how to run tests, a required env var, a gotcha).

WHEN NOT TO USE:
- Temporary task state or progress: use \`todo\`.
- Facts already in the project's instructions file or obvious from the code.

DO NOT USE FOR:
- Secrets, API keys, tokens or passwords. Never store them.
- Long notes or code; keep each fact to one short sentence.

EXAMPLES:
- {"fact": "Run tests with \`bun test\`; the e2e suite needs DATABASE_URL."}
- {"fact": "User prefers small commits with conventional commit messages."}`;

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Drop the oldest bullet lines until the text fits in `max` chars. Non-bullet lines are kept. */
export function capMemory(text: string, max = MEMORY_MAX_CHARS): { text: string; dropped: number } {
  const lines = text.split("\n");
  let dropped = 0;
  const size = () => lines.join("\n").length;
  while (size() > max) {
    const idx = lines.findIndex((l) => l.startsWith("- "));
    // Never drop the last bullet (the one just added).
    if (idx === -1 || idx === lines.findLastIndex((l) => l.startsWith("- "))) break;
    lines.splice(idx, 1);
    dropped++;
  }
  return { text: lines.join("\n"), dropped };
}

export const createRememberTool: ToolFactory = (ctx) =>
  tool({
    description: DESCRIPTION,
    inputSchema: z.object({
      fact: z.string().describe("One short sentence to remember in future sessions."),
    }),
    execute: async ({ fact }) => {
      try {
        let clean = fact.replace(/\s+/g, " ").trim();
        if (!clean) return "Error: fact is empty.";
        if (clean.length > FACT_MAX_CHARS) clean = `${clean.slice(0, FACT_MAX_CHARS)}…`;

        await mkdir(path.dirname(ctx.memoryPath), { recursive: true });
        let existing = "";
        try {
          existing = await readFile(ctx.memoryPath, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }

        const bullet = `- (${today()}) ${clean}`;
        const base = existing.replace(/\s+$/, "");
        // -1 leaves room for the trailing newline.
        const { text, dropped } = capMemory(base ? `${base}\n${bullet}` : bullet, MEMORY_MAX_CHARS - 1);
        await writeFile(ctx.memoryPath, `${text}\n`, "utf8");

        const rel = path.relative(ctx.root, ctx.memoryPath) || ctx.memoryPath;
        const note = dropped ? ` Dropped ${dropped} oldest ${dropped === 1 ? "entry" : "entries"} to stay under ${MEMORY_MAX_CHARS} chars.` : "";
        return `Remembered in ${rel}: ${clean}${note}`;
      } catch (err) {
        return `Error: could not save memory: ${(err as Error).message}`;
      }
    },
  });
