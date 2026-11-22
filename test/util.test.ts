import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, symlink, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { capLines, capChars, capTail } from "../src/util/truncate.ts";
import { safeResolve, PathEscapeError } from "../src/util/paths.ts";

describe("truncate", () => {
  test("capLines leaves short input alone", () => {
    expect(capLines("a\nb", 5)).toBe("a\nb");
  });
  test("capLines cuts and adds notice with hint", () => {
    const out = capLines("1\n2\n3\n4", 2, "use offset");
    expect(out.startsWith("1\n2\n")).toBe(true);
    expect(out).toContain("showing 2 of 4 lines");
    expect(out).toContain("use offset");
  });
  test("capChars keeps the head", () => {
    const out = capChars("abcdefghij", 3);
    expect(out.startsWith("abc\n")).toBe(true);
    expect(out).toContain("first 3 of 10");
  });
  test("capTail keeps the tail", () => {
    const out = capTail("abcdefghij", 3);
    expect(out.endsWith("\nhij")).toBe(true);
    expect(out).toContain("last 3 of 10");
  });
});

describe("safeResolve", () => {
  let base: string, root: string, outside: string;
  beforeAll(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), "lex-paths-")));
    root = path.join(base, "root");
    outside = path.join(base, "outside");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "x");
    await symlink(outside, path.join(root, "escape"));
  });
  afterAll(() => rm(base, { recursive: true, force: true }));

  test("resolves paths inside root", async () => {
    expect(await safeResolve(root, "src")).toBe(path.join(root, "src"));
    expect(await safeResolve(root, ".")).toBe(root);
  });
  test("allows not-yet-existing files inside root", async () => {
    expect(await safeResolve(root, "new/dir/file.ts")).toBe(path.join(root, "new/dir/file.ts"));
  });
  test("rejects ../ escapes", async () => {
    expect(safeResolve(root, "../outside/secret.txt")).rejects.toBeInstanceOf(PathEscapeError);
  });
  test("rejects absolute paths outside root", async () => {
    expect(safeResolve(root, "/etc/passwd")).rejects.toBeInstanceOf(PathEscapeError);
  });
  test("rejects symlinks that escape root", async () => {
    expect(safeResolve(root, "escape/secret.txt")).rejects.toBeInstanceOf(PathEscapeError);
    expect(safeResolve(root, "escape/new.txt")).rejects.toBeInstanceOf(PathEscapeError);
  });
  test("rejects sibling dirs sharing a prefix", async () => {
    await mkdir(path.join(base, "root2"), { recursive: true });
    expect(safeResolve(root, "../root2")).rejects.toBeInstanceOf(PathEscapeError);
  });
});
