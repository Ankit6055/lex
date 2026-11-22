// Skills: progressive disclosure. Only each skill's name and description go in the system prompt;
// the full SKILL.md body is loaded on demand by the `load_skill` tool.
//   <root>/skills/<name>/SKILL.md      (project, wins on a name clash)
//   ~/.lex/skills/<name>/SKILL.md      (user; LEX_HOME overrides ~/.lex)
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { configDir } from "./auth.ts";

export const SKILL_FILE = "SKILL.md";
export const SKILL_DESCRIPTION_MAX_CHARS = 200;

export interface Skill {
  name: string;
  description: string;
  file: string;                    // absolute path to SKILL.md
  source: "project" | "user";
}

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;                    // SKILL.md without its frontmatter
}

/** The skill directories to search, highest priority first. */
export function skillDirs(root: string): { dir: string; source: Skill["source"] }[] {
  return [
    { dir: path.join(root, "skills"), source: "project" },
    { dir: path.join(configDir(), "skills"), source: "user" },
  ];
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const unquote = (s: string) => {
  const t = s.trim();
  return t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))) ? t.slice(1, -1) : t;
};

function capDescription(s: string): string {
  const d = oneLine(s);
  return d.length > SKILL_DESCRIPTION_MAX_CHARS ? `${d.slice(0, SKILL_DESCRIPTION_MAX_CHARS - 1)}…` : d;
}

/**
 * Parse simple YAML-ish frontmatter by hand: `key: value` lines, optional quotes, and
 * block scalars (`key: >` or `key: |` followed by indented lines). Anything fancier is ignored.
 */
function parseFrontmatter(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    let value = m[2]!.trim();
    if (/^[>|][+-]?$/.test(value) || value === "") {
      // Block scalar or a value continued on indented lines.
      const parts: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === "")) {
        parts.push(lines[++i]!.trim());
      }
      value = parts.join(" ");
    }
    out[key] = unquote(value);
  }
  return out;
}

/** Split SKILL.md into name, description and body. Falls back to `dirName` and the first body line. */
export function parseSkill(text: string, dirName: string): ParsedSkill {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  let meta: Record<string, string> = {};
  let body = src;
  const fm = src.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (fm) {
    meta = parseFrontmatter(fm[1]!.split("\n"));
    body = src.slice(fm[0].length);
  }
  body = body.replace(/^\s*\n/, "").trimEnd();

  const name = oneLine(meta.name ?? "") || dirName;
  let description = meta.description ?? "";
  if (!oneLine(description)) {
    const first = body.split("\n").find((l) => l.trim()) ?? "";
    description = first.replace(/^\s*#+\s*/, "");
  }
  return { name, description: capDescription(description), body };
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory(); // follows symlinks
  } catch {
    return false;
  }
}

async function readSkillsIn(dir: string, source: Skill["source"]): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const found = await Promise.all(
    entries.sort().map(async (entry): Promise<Skill | undefined> => {
      if (entry.startsWith(".")) return undefined;
      const sub = path.join(dir, entry);
      if (!(await isDir(sub))) return undefined;
      const file = path.join(sub, SKILL_FILE);
      try {
        const { name, description } = parseSkill(await readFile(file, "utf8"), entry);
        return { name, description, file, source };
      } catch {
        return undefined; // no SKILL.md (or unreadable): not a skill
      }
    }),
  );
  return found.filter((s): s is Skill => !!s);
}

/** Every skill, sorted by name. A project skill hides a user skill with the same name. */
export async function discoverSkills(root: string): Promise<Skill[]> {
  const byName = new Map<string, Skill>();
  for (const { dir, source } of skillDirs(root)) {
    for (const s of await readSkillsIn(dir, source)) {
      if (!byName.has(s.name)) byName.set(s.name, s);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Load one skill by name (as listed by discoverSkills). `undefined` if there is no such skill. */
export async function loadSkill(root: string, name: string): Promise<(Skill & { body: string }) | undefined> {
  const wanted = name.trim();
  const all = await discoverSkills(root);
  const skill = all.find((s) => s.name === wanted) ?? all.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
  if (!skill) return undefined;
  const { body } = parseSkill(await readFile(skill.file, "utf8"), path.basename(path.dirname(skill.file)));
  return { ...skill, body };
}
