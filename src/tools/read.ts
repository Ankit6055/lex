import { tool } from "ai";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import type { ToolFactory } from "../types.ts";
import { fileError, looksBinary, resolveInRoot } from "../util/fs.ts";

export const READ_MAX_LINES = 500;
const READ_MAX_LINE_CHARS = 2000;

const description = `Read a file; lines are prefixed with their line number. Output is capped at ${READ_MAX_LINES} lines: use offset/limit to page. Strip the prefixes before using text in edit.`;

export const createReadTool: ToolFactory = (ctx) =>
  tool({
    description,
    inputSchema: z.object({
      path: z.string().describe("File path"),
      offset: z.number().int().min(1).optional().describe("First line (1-based)"),
      limit: z.number().int().min(1).optional().describe("Max lines"),
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
