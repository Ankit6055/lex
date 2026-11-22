import { spawn } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";
import type { ToolFactory } from "../types.ts";
import { capTail } from "../util/truncate.ts";
import { DENIED_MESSAGE } from "../approval.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 5_000;
/** Output kept in memory while a command runs; only the tail is ever returned. */
const BUFFER_MAX = 50_000;
const BUFFER_KEEP = 20_000;

export const READONLY_BASH =
  "Refused: this session is read-only. Only safe read commands run (ls, pwd, cat, head, tail, wc, which, echo, git status/log/diff/show, with no pipes, redirects or chaining). Tell the user what you would run instead.";

const DESCRIPTION = `Run a shell command in the project root and return its exit code plus combined stdout/stderr (last ${OUTPUT_CAP} chars).

WHEN TO USE:
- Running tests, builds, type checks, linters, package scripts (e.g. \`bun test\`, \`npm run build\`).
- Inspecting git state (\`git status\`, \`git diff\`, \`git log -5 --oneline\`).
- Running a program to see its real behavior or error output.

WHEN NOT TO USE:
- Reading a file: use \`read\`. Listing or finding files: use \`ls\`. Searching contents: use \`grep\`.
- Creating or changing files: use \`write\` / \`edit\` (not echo/sed/cat redirects).
- Long-running servers or watchers (\`npm run dev\`, \`--watch\`): they block until the timeout kills them.

DO NOT USE FOR:
- Interactive commands that wait for input (editors, prompts, REPLs); stdin is closed.
- Destructive or irreversible actions (rm -rf, force push, dropping data) unless the user explicitly asked.
- Talking to the user; use \`ask_user\` for questions.

EXAMPLES:
- {"command": "bun test"}
- {"command": "git diff --stat"}
- {"command": "npm run build", "timeout_ms": 180000}

Notes: commands other than simple read-only ones need the user's approval. If the user denies, ask them how to proceed.`;

type RunResult = { header: string; output: string };

function run(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    const useGroup = process.platform !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        shell: true,
        cwd,
        detached: useGroup,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat" },
      });
    } catch (err) {
      resolve({ header: "error", output: `failed to start command: ${(err as Error).message}` });
      return;
    }

    let out = "";
    let total = 0;
    let dropped = false;
    const onData = (chunk: string) => {
      out += chunk;
      total += chunk.length;
      if (out.length > BUFFER_MAX) {
        out = out.slice(out.length - BUFFER_KEEP);
        dropped = true;
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let finished = false;
    let stopReason: "timeout" | "abort" | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const kill = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (useGroup) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    const finish = (header: string) => {
      if (finished) return;
      finished = true;
      for (const t of timers) clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      const body = dropped
        ? `[truncated: showing last ${OUTPUT_CAP} of ${total} chars]\n${out.slice(out.length - OUTPUT_CAP)}`
        : capTail(out, OUTPUT_CAP);
      resolve({ header, output: body });
    };

    const stop = (reason: "timeout" | "abort") => {
      if (finished || stopReason) return;
      stopReason = reason;
      kill("SIGTERM");
      timers.push(setTimeout(() => kill("SIGKILL"), 2_000));
      // If something detached still holds the pipes open, give up waiting after a while.
      timers.push(setTimeout(() => finish(stopHeader()), 5_000));
    };
    const stopHeader = () =>
      stopReason === "timeout" ? `timed out after ${timeoutMs}ms` : "aborted (the user cancelled this turn)";

    const onAbort = () => stop("abort");
    signal?.addEventListener("abort", onAbort, { once: true });
    timers.push(setTimeout(() => stop("timeout"), timeoutMs));

    child.on("error", (err) => {
      onData(`\nfailed to run command: ${err.message}`);
      finish("error");
    });
    child.on("close", (code, sig) => {
      if (stopReason) finish(stopHeader());
      else if (code !== null) finish(`exit ${code}`);
      else finish(`killed by ${sig ?? "signal"}`);
    });
  });
}

export const createBashTool: ToolFactory = (ctx) =>
  tool({
    description: DESCRIPTION,
    inputSchema: z.object({
      command: z.string().describe("The shell command to run in the project root."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(600_000)
        .optional()
        .describe(`Kill the command after this many ms (default ${DEFAULT_TIMEOUT_MS}).`),
    }),
    execute: async ({ command, timeout_ms }, options) => {
      try {
        if (!command.trim()) return "Error: command is empty.";
        if (!ctx.approver.isSafeCommand(command)) {
          const verdict = await ctx.approver.request({
            tool: "bash",
            summary: command,
            alwaysKey: `bash:${command}`,
          });
          if (verdict === "deny") return DENIED_MESSAGE;
          if (verdict === "readonly") return READONLY_BASH;
        }
        if (options?.abortSignal?.aborted) return "Aborted before running (the user cancelled this turn).";
        const { header, output } = await run(
          command,
          ctx.root,
          timeout_ms ?? DEFAULT_TIMEOUT_MS,
          options?.abortSignal,
        );
        return `${header}\n${output || "(no output)"}`;
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  });
