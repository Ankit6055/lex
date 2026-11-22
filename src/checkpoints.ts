// Checkpoints: snapshot the project before each turn so /undo can put files back.
// Uses a private git repository in ~/.lex/checkpoints/<project hash> with the project as its work
// tree, so it works in non-git projects too, never shows up in the project, and never touches the
// user's own repository, index or stash.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { configDir } from "./auth.ts";

const run = promisify(execFile);

export interface UndoResult { label: string; restored: string[]; removed: string[] }

export interface Checkpoints {
  /** Snapshot the project; returns false if snapshots aren't available (no git, or an error). */
  before(label: string): Promise<boolean>;
  /** Call after the turn: keeps the snapshot only if the turn changed files. */
  after(): Promise<void>;
  /** Restore the files changed by the most recent turn that changed any. */
  undo(): Promise<UndoResult | null>;
  readonly count: number;
}

export function createCheckpoints(root: string): Checkpoints {
  const gitDir = path.join(configDir(), "checkpoints", createHash("sha256").update(root).digest("hex").slice(0, 16));
  const git = (...args: string[]) =>
    run("git", ["--git-dir", gitDir, "--work-tree", root, "-c", "user.name=lex", "-c", "user.email=lex@localhost", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd: root, maxBuffer: 64 << 20 });
  const stack: { label: string; commit: string }[] = [];
  let pending: { label: string; commit: string } | null = null;
  let ready: Promise<boolean> | null = null;

  async function init(): Promise<boolean> {
    try {
      await mkdir(gitDir, { recursive: true });
      await git("init", "-q");
      await mkdir(path.join(gitDir, "info"), { recursive: true });
      await writeFile(path.join(gitDir, "info", "exclude"), ".lex/\nnode_modules/\n");
      return true;
    } catch {
      return false;
    }
  }

  async function snapshot(label: string): Promise<string> {
    await git("add", "-A");
    await git("commit", "-q", "--allow-empty", "--no-verify", "-m", label);
    return (await git("rev-parse", "HEAD")).stdout.trim();
  }

  return {
    get count() { return stack.length; },

    async before(label) {
      ready ??= init();
      if (!(await ready)) return false;
      try {
        pending = { label, commit: await snapshot(`before: ${label}`) };
        return true;
      } catch {
        pending = null;
        return false;
      }
    },

    async after() {
      if (!pending) return;
      const cp = pending;
      pending = null;
      try {
        await git("add", "-A");
        const { stdout } = await git("diff", "--cached", "--name-only", cp.commit);
        if (stdout.trim()) stack.push(cp);
      } catch { /* checkpoints are best-effort */ }
    },

    async undo() {
      const cp = stack.pop();
      if (!cp) return null;
      await git("add", "-A");
      const changed = (await git("diff", "--cached", "--name-status", "--no-renames", cp.commit)).stdout.trim().split("\n").filter(Boolean);
      const removed: string[] = [], restored: string[] = [];
      for (const line of changed) {
        const [status, file] = line.split("\t") as [string, string];
        if (status === "A") removed.push(file);   // created after the checkpoint
        else restored.push(file);                 // modified or deleted since
      }
      for (const f of removed) await rm(path.join(root, f), { force: true });
      if (restored.length) await git("checkout", cp.commit, "--", ...restored);
      await git("reset", "-q", cp.commit);
      return { label: cp.label, restored, removed };
    },
  };
}
