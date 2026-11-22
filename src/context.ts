import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PromptContext } from "./types.ts";
import { capChars } from "./util/truncate.ts";

export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "LEX.md"] as const;
export const MAX_INSTRUCTION_CHARS = 8000;

/** Run a git command in `cwd`; resolves to trimmed stdout, or undefined on any failure. */
function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000, windowsHide: true }, (err, stdout) => {
      const out = err ? "" : String(stdout).trim();
      resolve(out || undefined);
    });
  });
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function osName(): string {
  // os.release() is the kernel version, so label it as such on macOS.
  const p = os.platform();
  if (p === "darwin") return `macOS (Darwin ${os.release()})`;
  if (p === "win32") return `Windows ${os.release()}`;
  if (p === "linux") return `Linux ${os.release()}`;
  return `${p} ${os.release()}`;
}

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Directories to search, nearest first: root, then each parent up to and including the git root. */
function searchDirs(root: string, gitRoot: string | undefined): string[] {
  const start = path.resolve(root);
  if (!gitRoot) return [start];
  const stop = path.resolve(gitRoot);
  const rel = path.relative(stop, start);
  // root is outside the git toplevel (shouldn't happen): only check root.
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [start];
  const dirs: string[] = [];
  let dir = start;
  while (true) {
    dirs.push(dir);
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

async function findProjectInstructions(dirs: string[]): Promise<PromptContext["projectInstructions"]> {
  for (const dir of dirs) {
    for (const name of INSTRUCTION_FILES) {
      const file = path.join(dir, name);
      const content = await readIfExists(file);
      if (content !== undefined && content.trim()) {
        return { file, content: capChars(content.trim(), MAX_INSTRUCTION_CHARS) };
      }
    }
  }
  return undefined;
}

export async function loadContext(root: string): Promise<Omit<PromptContext, "toolNames">> {
  const [gitBranch, gitRoot] = await Promise.all([
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["rev-parse", "--show-toplevel"]),
  ]);
  // git prints the real toplevel path, so compare against the real root (macOS /var -> /private/var).
  const realRoot = await realpath(root).catch(() => root);
  const [projectInstructions, memoryRaw] = await Promise.all([
    findProjectInstructions(searchDirs(realRoot, gitRoot)),
    readIfExists(path.join(root, ".lex", "memory.md")),
  ]);
  const memory = memoryRaw?.trim() || undefined;

  const ctx: Omit<PromptContext, "toolNames"> = { cwd: root, os: osName(), date: today() };
  if (gitBranch) ctx.gitBranch = gitBranch;
  if (projectInstructions) ctx.projectInstructions = projectInstructions;
  if (memory) ctx.memory = memory;
  return ctx;
}
