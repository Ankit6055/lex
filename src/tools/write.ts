import { tool } from "ai";
import { z } from "zod";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApprovalResult, ToolFactory } from "../types.ts";
import { fileError, resolveInRoot } from "./read.ts";

// ---- serialize file mutations (shared by write and edit) ----

let queue: Promise<unknown> = Promise.resolve();

/** Run `fn` after every previously queued mutation has finished, one at a time. */
export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export const DENIED_MESSAGE = "User denied this action. Ask them how to proceed.";

/** Message for a refused mutation, or undefined when the approver allowed it. */
export function refusalMessage(result: ApprovalResult, rel: string): string | undefined {
  if (result === "deny") return DENIED_MESSAGE;
  if (result === "readonly") {
    return `The session is in read-only mode, so ${rel} was not changed. Don't retry; describe the change you would make and let the user apply it or switch modes.`;
  }
  return undefined;
}

export function countLines(s: string): number {
  if (s.length === 0) return 0;
  const n = s.split("\n").length;
  return s.endsWith("\n") ? n - 1 : n;
}

const PREVIEW_LINES = 20;

const description = `Create a new file, or completely replace an existing file, with the given content. Parent directories are created as needed. The user is asked to approve each write.

WHEN TO USE:
- Creating a brand-new file (source, test, config, docs).
- Rewriting a small file almost entirely, where a targeted edit would be clumsier.

WHEN NOT TO USE:
- Changing part of an existing file: use edit, which is safer and shows the user a precise diff.
- You haven't read an existing file yet: read it first so you don't lose content.

DO NOT USE FOR:
- Paths outside the project root; they are refused.
- Appending to a file (write replaces the whole file; use edit or include the full content).
- Binary files, or generated output that a build step should produce.

EXAMPLES:
- write({ path: "src/utils/slug.ts", content: "export function slug(s: string) {\\n  return s.toLowerCase();\\n}\\n" })
- write({ path: "test/slug.test.ts", content: "..." })

If the user denies the write, or the session is read-only, nothing is written and you get a message saying so: don't retry the same write; ask the user how to proceed.`;

export const createWriteTool: ToolFactory = (ctx) =>
  tool({
    description,
    inputSchema: z.object({
      path: z.string().describe("File path, relative to the project root"),
      content: z.string().describe("The full new content of the file"),
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
