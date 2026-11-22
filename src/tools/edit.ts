import { tool } from "ai";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import pc from "picocolors";
import type { ToolFactory } from "../types.ts";
import { fileError, resolveInRoot } from "../util/fs.ts";
import { refusalMessage } from "../approval.ts";
import { serialize } from "../util/serialize.ts";

const DIFF_MAX_LINES = 40;

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

/**
 * A small +/− diff for one replacement: common leading/trailing lines are trimmed,
 * `startLine` is where old_string begins in the file. Counts are per occurrence.
 */
export function miniDiff(
  oldStr: string,
  newStr: string,
  startLine: number,
  color = true,
): { text: string; added: number; removed: number } {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const removed = a.slice(pre, a.length - suf);
  const added = b.slice(pre, b.length - suf);
  const red = color ? pc.red : (s: string) => s;
  const green = color ? pc.green : (s: string) => s;
  const dim = color ? pc.dim : (s: string) => s;
  const lines = [dim(`@@ line ${startLine + pre} @@`), ...removed.map((l) => red(`- ${l}`)), ...added.map((l) => green(`+ ${l}`))];
  let text = lines.slice(0, DIFF_MAX_LINES).join("\n");
  if (lines.length > DIFF_MAX_LINES) text += `\n${dim(`… (${lines.length - DIFF_MAX_LINES} more diff lines)`)}`;
  return { text, added: added.length, removed: removed.length };
}

const description = `Replace exact text in a file. old_string must match exactly once unless replace_all is set. Read the file first. Asks the user for approval.`;

export const createEditTool: ToolFactory = (ctx) =>
  tool({
    description,
    inputSchema: z.object({
      path: z.string().describe("File path"),
      old_string: z.string().describe("Exact text to replace"),
      new_string: z.string().describe("Replacement text"),
      replace_all: z.boolean().optional().describe("Replace every occurrence"),
    }),
    execute: async ({ path: p, old_string, new_string, replace_all }) =>
      serialize(async () => {
        try {
          if (old_string === "") return "Error: old_string is empty. To create a file use write; to insert text, include a nearby line in old_string.";
          if (old_string === new_string) return "Error: old_string and new_string are identical, so there is nothing to change.";
          const { abs, rel } = await resolveInRoot(ctx.root, p);
          const before = await readFile(abs, "utf8");

          const count = countOccurrences(before, old_string);
          if (count === 0) {
            return `Error: old_string was not found in ${rel}. It must match exactly, including whitespace and indentation. Read the file again and copy the text precisely.`;
          }
          if (count > 1 && !replace_all) {
            return `Error: old_string matches ${count} times in ${rel}. Include more surrounding lines to make it unique, or set replace_all: true to replace all ${count}.`;
          }

          const startLine = before.slice(0, before.indexOf(old_string)).split("\n").length;
          const diff = miniDiff(old_string, new_string, startLine);
          const added = diff.added * count;
          const removed = diff.removed * count;
          const stats = `(+${added} −${removed})`;
          const detail = count > 1 ? `${diff.text}\n${pc.dim(`(first of ${count} replacements shown)`)}` : diff.text;

          const result = await ctx.approver.request({
            tool: "edit",
            summary: `${rel} ${stats}${count > 1 ? `, ${count} replacements` : ""}`,
            detail,
            alwaysKey: "edit",
          });
          const refused = refusalMessage(result, rel);
          if (refused) return refused;

          // split/join, not String.replace: replacement text must not interpret "$&" etc.
          const after = before.split(old_string).join(new_string);
          await writeFile(abs, after, "utf8");
          return `Edited ${rel}: replaced ${count} occurrence${count === 1 ? "" : "s"} ${stats}.`;
        } catch (e) {
          return fileError(e, p);
        }
      }),
  });
