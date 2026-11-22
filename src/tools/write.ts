import { tool } from "ai";
import { z } from "zod";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolFactory } from "../types.ts";
import { refusalMessage } from "../approval.ts";
import { serialize } from "../util/serialize.ts";
import { fileError, resolveInRoot } from "../util/fs.ts";

export function countLines(s: string): number {
  if (s.length === 0) return 0;
  const n = s.split("\n").length;
  return s.endsWith("\n") ? n - 1 : n;
}

const PREVIEW_LINES = 20;

const description = `Create or overwrite a file; parent directories are created. Asks the user for approval.`;

export const createWriteTool: ToolFactory = (ctx) =>
  tool({
    description,
    inputSchema: z.object({
      path: z.string().describe("File path"),
      content: z.string().describe("Full file content"),
    }),
    execute: async ({ path: p, content }) =>
      serialize(async () => {
        try {
          const { abs, rel } = await resolveInRoot(ctx.root, p);
          let exists = false;
          try {
            const st = await stat(abs);
            if (st.isDirectory()) return `Error: ${rel} is a directory; write needs a file path.`;
            exists = true;
          } catch {
            // new file
          }
          const lines = countLines(content);
          const allLines = content.split("\n");
          const preview = allLines.slice(0, PREVIEW_LINES).join("\n");
          const detail =
            allLines.length > PREVIEW_LINES ? `${preview}\n… (${allLines.length - PREVIEW_LINES} more lines)` : preview;

          const result = await ctx.approver.request({
            tool: "write",
            summary: `${rel} (${exists ? "overwrite" : "new file"}, ${lines} line${lines === 1 ? "" : "s"})`,
            detail,
            alwaysKey: "write",
          });
          const refused = refusalMessage(result, rel);
          if (refused) return refused;

          await mkdir(path.dirname(abs), { recursive: true });
          await writeFile(abs, content, "utf8");
          return `${exists ? "Overwrote" : "Created"} ${rel} (${lines} line${lines === 1 ? "" : "s"}).`;
        } catch (e) {
          return fileError(e, p);
        }
      }),
  });
