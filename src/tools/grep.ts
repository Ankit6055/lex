import { tool, type Tool } from "ai";
import { z } from "zod";
import { readdir, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { ToolContext, ToolFactory } from "../types.ts";
import { fileError, looksBinary, resolveInRoot, toRel } from "../util/fs.ts";
import { IGNORED_DIRS } from "./ls.ts";

export const GREP_MAX_MATCHES = 50;
export const GREP_MAX_LINE_CHARS = 500;
const JS_MAX_FILE_BYTES = 1_000_000;
const RG_TIMEOUT_MS = 30_000;

export type GrepEngine = "auto" | "rg" | "js";
export interface GrepMatch {
  file: string; // root-relative, forward slashes
  line: number;
  text: string;
}
interface GrepResult {
  matches: GrepMatch[]; // at most GREP_MAX_MATCHES
  total: number;
  error?: string;
}

// ---- rg detection: spawn the real binary (a shell function named rg doesn't count) ----

let rgAvailable: Promise<boolean> | undefined;
export function hasRipgrep(): Promise<boolean> {
  rgAvailable ??= new Promise<boolean>((resolve) => {
    try {
      const child = spawn("rg", ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
  return rgAvailable;
}

// ---- glob matching for the JS fallback (supports **, *, ?, {a,b}, [abc]) ----

export function globToRegExp(glob: string): RegExp {
  let re = "";
  let inBrace = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more directories; a bare "**" matches anything
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      inBrace = true;
      re += "(?:";
    } else if (c === "}" && inBrace) {
      inBrace = false;
      re += ")";
    } else if (c === "," && inBrace) re += "|";
    else if (c === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) re += "\\[";
      else {
        re += `[${glob.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** rg-like semantics: a glob without "/" matches the file's basename anywhere. */
function makeGlobFilter(glob: string | undefined): (rel: string) => boolean {
  if (!glob) return () => true;
  const re = globToRegExp(glob);
  if (!glob.includes("/")) return (rel) => re.test(path.posix.basename(rel));
  return (rel) => re.test(rel);
}

function capLine(text: string): string {
  return text.length > GREP_MAX_LINE_CHARS
    ? `${text.slice(0, GREP_MAX_LINE_CHARS)} [line truncated: ${text.length} chars]`
    : text;
}

// ---- pure-JS engine ----

export async function grepJs(realRoot: string, target: string, pattern: string, glob?: string): Promise<GrepResult> {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    return { matches: [], total: 0, error: `Error: invalid regex ${JSON.stringify(pattern)}: ${(e as Error).message}` };
  }
  const filter = makeGlobFilter(glob);
  const matches: GrepMatch[] = [];
  let total = 0;

  const searchFile = async (abs: string, explicit: boolean) => {
    const rel = toRel(realRoot, abs);
    if (!explicit && !filter(rel)) return;
    try {
      const st = await stat(abs);
      if (st.size > JS_MAX_FILE_BYTES || (await looksBinary(abs))) return;
      const lines = (await readFile(abs, "utf8")).split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.replace(/\r$/, "");
        if (re.test(line)) {
          total++;
          if (matches.length < GREP_MAX_MATCHES) matches.push({ file: rel, line: i + 1, text: capLine(line) });
        }
      }
    } catch {
      // unreadable file: skip, like rg does
    }
  };

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!IGNORED_DIRS.has(ent.name)) await walk(abs);
      } else if (ent.isFile()) {
        await searchFile(abs, false);
      }
    }
  };

  const st = await stat(target);
  if (st.isDirectory()) await walk(target);
  else await searchFile(target, true);
  return { matches, total };
}

// ---- ripgrep engine ----

export function grepRg(
  realRoot: string,
  target: string,
  pattern: string,
  glob?: string,
  abortSignal?: AbortSignal,
): Promise<GrepResult> {
  return new Promise((resolve) => {
    const args = ["--line-number", "--no-heading", "--with-filename", "--null", "--color", "never"];
    for (const d of IGNORED_DIRS) args.push("--glob", `!${d}`);
    if (glob) args.push("--glob", glob);
    args.push("--regexp", pattern, "--", toRel(realRoot, target));

    const matches: GrepMatch[] = [];
    let total = 0;
    let stderr = "";
    let buf = "";
    let settled = false;
    const finish = (r: GrepResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const child = spawn("rg", args, { cwd: realRoot, stdio: ["ignore", "pipe", "pipe"], signal: abortSignal });
    const timer = setTimeout(() => child.kill(), RG_TIMEOUT_MS);

    const onLine = (raw: string) => {
      if (!raw) return;
      // with --null: "<path>\0<line>:<text>"
      const nul = raw.indexOf("\0");
      if (nul === -1) return;
      const rest = raw.slice(nul + 1);
      const colon = rest.indexOf(":");
      const lineNo = Number(rest.slice(0, colon));
      if (colon === -1 || !Number.isFinite(lineNo)) return;
      total++;
      if (matches.length < GREP_MAX_MATCHES) {
        const file = raw.slice(0, nul).split(path.sep).join("/").replace(/^\.\//, "");
        matches.push({ file, line: lineNo, text: capLine(rest.slice(colon + 1).replace(/\r$/, "")) });
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.on("error", (e) => finish({ matches, total, error: `Error: failed to run rg: ${e.message}` }));
    child.on("close", (code) => {
      onLine(buf);
      // rg: 0 = matches, 1 = no matches, 2 = error (possibly with partial matches)
      if (code === 2 && total === 0) finish({ matches, total, error: `Error: rg failed: ${stderr.trim() || "unknown error"}` });
      else if (code === null && !abortSignal?.aborted) {
        finish({ matches, total, error: total ? undefined : `Error: rg timed out after ${RG_TIMEOUT_MS / 1000}s` });
      } else finish({ matches, total });
    });
  });
}

// ---- tool ----

const description = `Search file contents with a regular expression. Returns matching lines as "path:line: text", relative to the project root. Uses ripgrep when installed (respecting .gitignore), otherwise a built-in search.

WHEN TO USE:
- You need to find where something is defined or used: a function, class, variable, string, config key, error message.
- You want to narrow a search to certain files with glob, e.g. "*.ts" or "src/**/*.tsx".

WHEN NOT TO USE:
- You want to find files by name: use ls with a pattern.
- You already know the file and want to see it: use read.

DO NOT USE FOR:
- Paths outside the project root; they are refused.
- Searching node_modules, .git or dist; they are skipped.
- Reading whole files: grep shows single lines only, so follow up with read.

EXAMPLES:
- grep({ pattern: "function createServer" })
- grep({ pattern: "TODO|FIXME", path: "src" })
- grep({ pattern: "import .* from \\"zod\\"", glob: "*.ts" })
- grep({ pattern: "export (const|function) \\\\w+Tool", path: "src/tools" })

The pattern is a regex (JavaScript/Rust syntax, case-sensitive). Output is capped at ${GREP_MAX_MATCHES} matches with the total count; each line is cut at ${GREP_MAX_LINE_CHARS} chars. If capped, refine the pattern, path or glob.`;

/** Factory with an injectable engine so tests can force the JS fallback. */
export function makeGrepTool(ctx: ToolContext, opts: { engine?: GrepEngine } = {}): Tool {
  const engine = opts.engine ?? "auto";
  return tool({
    description,
    inputSchema: z.object({
      pattern: z.string().min(1).describe("Regular expression to search for"),
      path: z.string().optional().describe('File or directory to search, relative to the project root (default ".")'),
      glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts" or "src/**/*.md"'),
    }),
    execute: async ({ pattern, path: p = ".", glob }, options) => {
      try {
        const { abs, realRoot } = await resolveInRoot(ctx.root, p);
        await stat(abs); // ENOENT -> "file not found"
        const useRg = engine === "rg" || (engine === "auto" && (await hasRipgrep()));
        const r = useRg
          ? await grepRg(realRoot, abs, pattern, glob, options?.abortSignal)
          : await grepJs(realRoot, abs, pattern, glob);
        if (r.error) return r.error;
        if (r.total === 0) return `No matches for ${JSON.stringify(pattern)}${glob ? ` in files matching ${glob}` : ""}.`;
        const lines = r.matches.map((m) => `${m.file}:${m.line}: ${m.text}`);
        if (r.total > r.matches.length) {
          lines.push(
            `[truncated: showing ${r.matches.length} of ${r.total} matches. Refine the pattern, path or glob to see the rest.]`,
          );
        } else {
          lines.push(`(${r.total} match${r.total === 1 ? "" : "es"})`);
        }
        return lines.join("\n");
      } catch (e) {
        return fileError(e, p);
      }
    },
  });
}

export const createGrepTool: ToolFactory = (ctx) => makeGrepTool(ctx);
