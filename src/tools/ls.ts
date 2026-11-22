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

const description = `List files and directories in the project, optionally filtered by a glob pattern. Directories end with "/". Paths are relative to the project root.

WHEN TO USE:
- You are new to a project or folder and need to see what's in it: ls({}) or ls({ path: "src" }).
- You need to find files by name or extension across subfolders: ls({ pattern: "**/*.test.ts" }).

WHEN NOT TO USE:
- You are looking for text inside files: use grep.
- You already know the file path and want its contents: use read.

DO NOT USE FOR:
- Paths outside the project root, or patterns containing ".."; they are refused.
- Exploring node_modules, .git or dist; they are always skipped.

EXAMPLES:
- ls({})                                   // top level of the project
- ls({ path: "src/tools" })                // one directory
- ls({ pattern: "**/*.md" })               // all markdown files, recursively
- ls({ path: "src", pattern: "**/*.ts" })  // TypeScript files under src

The default pattern is "*" (the directory itself, not recursive). Output is capped at ${LS_MAX_ENTRIES} entries; when cut, the result says how many were found so you can narrow the pattern.`;

export const createLsTool: ToolFactory = (ctx) =>
  tool({
    description,
    inputSchema: z.object({
      path: z.string().optional().describe('Directory to list, relative to the project root (default ".")'),
      pattern: z.string().optional().describe('Glob pattern relative to path, e.g. "*.ts" or "**/*.test.ts" (default "*")'),
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
