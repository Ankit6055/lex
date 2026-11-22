import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, realpath, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCheckpoints } from "../src/checkpoints.ts";

let root: string;
const file = (p: string) => path.join(root, p);
const read = (p: string) => readFile(file(p), "utf8");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

let home: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "lex-cp-home-")));
  process.env.LEX_HOME = home;
  root = await realpath(await mkdtemp(path.join(tmpdir(), "lex-cp-")));
  await mkdir(file("src"));
  await writeFile(file("src/a.ts"), "a1\n");
  await writeFile(file("src/b.ts"), "b1\n");
});
afterEach(async () => {
  delete process.env.LEX_HOME;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("undo restores modified and deleted files and removes created ones (non-git project)", async () => {
  const cp = createCheckpoints(root);
  expect(await cp.before("fix a")).toBe(true);
  await writeFile(file("src/a.ts"), "a2\n");
  await rm(file("src/b.ts"));
  await writeFile(file("src/new.ts"), "new\n");
  await cp.after();
  expect(cp.count).toBe(1);

  const r = await cp.undo();
  expect(r?.label).toBe("fix a");
  expect(r?.restored.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  expect(r?.removed).toEqual(["src/new.ts"]);
  expect(await read("src/a.ts")).toBe("a1\n");
  expect(await read("src/b.ts")).toBe("b1\n");
  expect(existsSync(file("src/new.ts"))).toBe(false);
  expect(await cp.undo()).toBeNull();
});

test("turns that change nothing aren't stacked, so undo skips back to the last real change", async () => {
  const cp = createCheckpoints(root);
  await cp.before("edit");
  await writeFile(file("src/a.ts"), "a2\n");
  await cp.after();
  await cp.before("just a question");
  await cp.after();
  expect(cp.count).toBe(1);
  await cp.undo();
  expect(await read("src/a.ts")).toBe("a1\n");
});

test("undo walks back one turn at a time", async () => {
  const cp = createCheckpoints(root);
  await cp.before("one");
  await writeFile(file("src/a.ts"), "a2\n");
  await cp.after();
  await cp.before("two");
  await writeFile(file("src/a.ts"), "a3\n");
  await cp.after();
  await cp.undo();
  expect(await read("src/a.ts")).toBe("a2\n");
  await cp.undo();
  expect(await read("src/a.ts")).toBe("a1\n");
});

test("never touches the user's own git repo, and leaves gitignored files alone", async () => {
  git("init", "-q");
  await writeFile(file(".gitignore"), "*.log\n");
  git("add", "-A");
  git("-c", "user.name=u", "-c", "user.email=u@x", "commit", "-qm", "init");
  const head = git("rev-parse", "HEAD");
  await writeFile(file("src/a.ts"), "staged change\n");
  git("add", "src/a.ts");
  const statusBefore = git("status", "--porcelain");

  const cp = createCheckpoints(root);
  await cp.before("turn");
  await writeFile(file("src/b.ts"), "b2\n");
  await writeFile(file("debug.log"), "ignored\n");
  await cp.after();
  await cp.undo();

  expect(await read("src/b.ts")).toBe("b1\n");
  expect(await read("debug.log")).toBe("ignored\n"); // ignored by .gitignore, so not tracked or removed
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(git("status", "--porcelain")).toBe(statusBefore); // the user's staged change is still staged
  expect(git("status", "--porcelain")).not.toContain(".lex");
});
