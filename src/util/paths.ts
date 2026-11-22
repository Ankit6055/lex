import { realpath } from "node:fs/promises";
import path from "node:path";

export class PathEscapeError extends Error {
  constructor(p: string) {
    super(`path is outside the project root: ${p}`);
    this.name = "PathEscapeError";
  }
}

function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve `p` against `root` and refuse anything outside `root`.
 * Symlinks are followed: the deepest existing ancestor is realpath'd, so a
 * symlink inside the project that points outside it is rejected too, while
 * paths that don't exist yet (for `write`) still resolve.
 */
export async function safeResolve(root: string, p: string): Promise<string> {
  const realRoot = await realpath(root);
  const abs = path.resolve(realRoot, p);
  if (!isInside(realRoot, abs)) throw new PathEscapeError(p);

  let existing = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const resolved = path.join(existing, ...rest);
  if (!isInside(realRoot, resolved)) throw new PathEscapeError(p);
  return resolved;
}
