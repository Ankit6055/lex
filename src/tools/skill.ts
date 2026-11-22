import { tool } from "ai";
import { z } from "zod";
import type { ToolFactory } from "../types.ts";
import { discoverSkills, loadSkill } from "../skills.ts";
import { capChars } from "../util/truncate.ts";

export const SKILL_MAX_CHARS = 4_000;

const DESCRIPTION = `Load the full instructions of a skill listed in the "# Skills" section of your system prompt. Skills are reusable playbooks (SKILL.md files) the user keeps in skills/<name>/ or ~/.lex/skills/<name>/; only their names and one-line descriptions are in your prompt until you load one.

WHEN TO USE:
- The task matches a listed skill's description: load it before starting, then follow its instructions.
- You are unsure how a listed skill applies: load it and read the details.

WHEN NOT TO USE:
- No "# Skills" section is in your prompt, or no listed skill fits the task.
- You already loaded the same skill earlier in this conversation.

DO NOT USE FOR:
- Reading ordinary project files: use read.
- Guessing skill names; use only names from the "# Skills" list.

EXAMPLES:
- load_skill({ name: "release" })
- load_skill({ name: "write-tests" })

Returns the SKILL.md body without its frontmatter, capped at ${SKILL_MAX_CHARS} chars.`;

export const createLoadSkillTool: ToolFactory = (ctx) =>
  tool({
    description: DESCRIPTION,
    inputSchema: z.object({
      name: z.string().describe('Skill name exactly as listed in the "# Skills" section'),
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
