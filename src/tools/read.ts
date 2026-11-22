import { tool } from "ai";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import type { ToolFactory } from "../types.ts";
import { fileError, looksBinary, resolveInRoot } from "../util/fs.ts";

export const READ_MAX_LINES = 500;
const READ_MAX_LINE_CHARS = 2000;

const description = `Read a text file from the project, with each line prefixed by its 1-based line number.

WHEN TO USE:
- You need the exact contents of a file before editing it (always read before you edit).
- You want to inspect a specific region of a large file: pass offset (1-based start line) and limit.

WHEN NOT TO USE:
- You don't know where something is yet: use grep to find it, or ls to discover files first.
- You want to list a directory: use ls.

DO NOT USE FOR:
- Binary files (images, archives, compiled output); they are refused.
- Paths outside the project root; they are refused.
- Running or evaluating code; use bash.

EXAMPLES:
- read({ path: "src/index.ts" })
- read({ path: "src/big.ts", offset: 501, limit: 200 })  // continue after a truncated read

Output is capped at ${READ_MAX_LINES} lines per call; when cut, the result says which offset to use next. Line-number prefixes are not part of the file: strip them before using text in edit.`;

export const createReadTool: ToolFactory = (ctx) =>
  tool({
    description,
    inputSchema: z.object({
      path: z.string().describe("File path, relative to the project root"),
      offset: z.number().int().min(1).optional().describe("1-based line number to start from (default 1)"),
      limit: z.number().int().min(1).optional().describe(`Max lines to return (default and max ${READ_MAX_LINES})`),
    }),
    execute: async ({ path: p, offset, limit }) => {
      try {
        const { abs, rel } = await resolveInRoot(ctx.root, p);
        const st = await stat(abs);
        if (st.isDirectory()) return `Error: ${rel} is a directory, not a file. Use ls to list it.`;
        if (await looksBinary(abs)) return `Error: ${rel} appears to be a binary file; read only handles text.`;

        const text = await readFile(abs, "utf8");
        if (text.length === 0) return `(${rel} is empty)`;
        const lines = text.split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop(); // trailing newline
        const total = lines.length;

        const start = offset ?? 1;
        if (start > total) return `Error: offset ${start} is past the end of ${rel} (${total} lines).`;
        const want = Math.min(limit ?? READ_MAX_LINES, READ_MAX_LINES);
        const end = Math.min(start - 1 + want, total); // inclusive, 1-based
        const width = String(end).length;

        const out: string[] = [];
        for (let i = start; i <= end; i++) {
          let line = lines[i - 1] ?? "";
          if (line.length > READ_MAX_LINE_CHARS) {
            line = `${line.slice(0, READ_MAX_LINE_CHARS)} [line truncated: ${line.length} chars]`;
          }
          out.push(`${String(i).padStart(width)}\t${line}`);
        }
        if (end < total) {
          const capped = (limit ?? READ_MAX_LINES) > READ_MAX_LINES || limit === undefined;
          out.push(
            `[truncated: showing lines ${start}-${end} of ${total}${capped ? ` (cap is ${READ_MAX_LINES} lines per read)` : ""}. ` +
              `Use offset=${end + 1} to read more.]`,
          );
        }
        return out.join("\n");
      } catch (e) {
        return fileError(e, p);
      }
    },
  });
