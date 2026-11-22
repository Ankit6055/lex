// Small filesystem helpers shared by the file tools (read, ls, grep, write, edit).
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { PathEscapeError, safeResolve } from "./paths.ts";

/** Resolve a user path inside the project root. Returns the absolute path and a root-relative display path. */
export async function resolveInRoot(root: string, p: string): Promise<{ abs: string; rel: string; realRoot: string }> {
  const abs = await safeResolve(root, p);
  const realRoot = await realpath(root);
  return { abs, rel: toRel(realRoot, abs), realRoot };
}

/** Root-relative path with forward slashes ("." for the root itself). */
export function toRel(realRoot: string, abs: string): string {
  const rel = path.relative(realRoot, abs);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

/** Turn any thrown value into a model-readable error string. Never throws. */
export function fileError(e: unknown, p: string): string {
  if (e instanceof PathEscapeError) return `Error: ${e.message}. Only paths inside the project root are allowed.`;
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return `Error: file not found: ${p}`;
  if (code === "EACCES" || code === "EPERM") return `Error: permission denied: ${p}`;
  if (code === "EISDIR") return `Error: ${p} is a directory, not a file. Use ls to list it.`;
  if (code === "ENOTDIR") return `Error: a parent of ${p} is not a directory.`;
  const msg = e instanceof Error ? e.message : String(e);
  return `Error: ${msg}`;
}

/** True if the first chunk of the file contains a NUL byte. */
export async function looksBinary(abs: string): Promise<boolean> {
  const fh = await open(abs, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}
