import { tool } from "ai";
import { z } from "zod";
import type { ToolFactory } from "../types.ts";
import { discoverSkills, loadSkill } from "../skills.ts";
import { capChars } from "../util/truncate.ts";

export const SKILL_MAX_CHARS = 4_000;

const DESCRIPTION = `Load the full instructions of a skill listed in <skills>.`;

export const createLoadSkillTool: ToolFactory = (ctx) =>
  tool({
    description: DESCRIPTION,
    inputSchema: z.object({
      name: z.string().describe("Skill name"),
    }),
    execute: async ({ name }) => {
      try {
        const skill = await loadSkill(ctx.root, name);
        if (!skill) {
          const names = (await discoverSkills(ctx.root)).map((s) => s.name);
          return names.length
            ? `Error: unknown skill "${name}". Available skills: ${names.join(", ")}.`
            : `Error: unknown skill "${name}". No skills are installed (looked in skills/<name>/SKILL.md and ~/.lex/skills/<name>/SKILL.md).`;
        }
        const body = skill.body.trim() || "(this skill's SKILL.md has no body)";
        return `# Skill: ${skill.name}\n\n${capChars(body, SKILL_MAX_CHARS)}`;
      } catch (e) {
        return `Error: could not load skill "${name}": ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });
