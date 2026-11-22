import { tool } from "ai";
import { z } from "zod";
import { glob, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolFactory } from "../types.ts";
import { fileError, resolveInRoot, toRel } from "../util/fs.ts";

export const LS_MAX_ENTRIES = 200;
export const IGNORED_DIRS = new Set(["node_modules", ".git", "dist"]);

/** True if any path segment is an ignored directory name. Works for "a/b" and "a\\b". */
export function hasIgnoredSegment(p: string): boolean {
  return p.split(/[\\/]/).some((seg) => IGNORED_DIRS.has(seg));
}

const description = `List files and directories (glob pattern optional). Skips node_modules, .git and dist; capped at 200 entries.`;

export const createLsTool: ToolFactory = (ctx) =>
  tool({
    description,
    inputSchema: z.object({
      path: z.string().optional().describe("Directory (default .)"),
      pattern: z.string().optional().describe("Glob, e.g. **/*.ts"),
    }),
    execute: async ({ path: p = ".", pattern = "*" }) => {
      try {
        if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
          return `Error: pattern must be relative to the directory and must not contain "..": ${pattern}`;
        }
        const { abs, rel, realRoot } = await resolveInRoot(ctx.root, p);
        const st = await stat(abs);
        if (!st.isDirectory()) return `Error: ${rel} is not a directory. Use read to view a file.`;

        // Collect names first (cheap), then sort and stat only what we show.
        const names: string[] = [];
        let total = 0;
        for await (const match of glob(pattern, { cwd: abs, exclude: (m: string) => hasIgnoredSegment(String(m)) })) {
          const m = String(match);
          if (hasIgnoredSegment(m)) continue;
          const full = path.resolve(abs, m);
          const relToRoot = toRel(realRoot, full);
          if (relToRoot === ".." || relToRoot.startsWith("../")) continue; // defensive: never list outside the root
          total++;
          if (names.length < 10_000) names.push(relToRoot);
        }
        if (total === 0) return `(no entries in ${rel} matching ${pattern})`;
        names.sort();
        const shown: string[] = [];
        for (const name of names.slice(0, LS_MAX_ENTRIES)) {
          let isDir = false;
          try {
            isDir = (await stat(path.join(realRoot, name))).isDirectory();
          } catch {
            // broken symlink etc.: list it as a plain entry
          }
          shown.push(isDir ? `${name}/` : name);
        }
        let out = shown.join("\n");
        if (total > shown.length) {
          out += `\n[truncated: showing ${shown.length} of ${total} entries. Use a narrower path or pattern to see the rest.]`;
        }
        return out;
      } catch (e) {
        return fileError(e, p);
      }
    },
  });
