import type { ApprovalMode, ApprovalRequest, ApprovalResult, Approver, IO } from "./types.ts";

/** Commands that only read, allowed without asking (exact first-token match). */
const SAFE_COMMANDS = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "which", "echo"]);
/** `git <subcommand>` forms that only read. */
const SAFE_GIT_SUBCOMMANDS = new Set(["status", "log", "diff", "show"]);
/**
 * Any of these anywhere in the command means it could chain, redirect or substitute another
 * command, so it is never auto-allowed. A lone `&` (background + run the next command) is
 * rejected too, since `ls & rm -rf x` is the same bypass as `ls && rm -rf x`.
 */
const SHELL_OPERATORS = [";", "&", "|", ">", "<", "$(", "`", "\n", "\r"];

/**
 * Operator-aware allowlist. True only for a single plain command whose first token is exactly one of
 * `ls pwd cat head tail wc which echo`, or `git status|log|diff|show`, with no shell operators.
 * `catx`, `catastrophe` and `git status && rm -rf x` are all false.
 */
export function isSafeCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (SHELL_OPERATORS.some((op) => cmd.includes(op))) return false;
  const tokens = cmd.split(/\s+/);
  const first = tokens[0] ?? "";
  if (SAFE_COMMANDS.has(first)) return true;
  if (first === "git") {
    const sub = tokens[1] ?? "";
    if (!SAFE_GIT_SUBCOMMANDS.has(sub)) return false;
    // `git diff --output=f` / `git log --output f` write files.
    if (tokens.some((t) => t.startsWith("--output"))) return false;
    return true;
  }
  return false;
}

/** The text after "[a]lways": the command for bash keys, or the whole tool for write/edit. */
function alwaysLabel(req: ApprovalRequest): string {
  const prefix = `${req.tool}:`;
  if (req.alwaysKey.startsWith(prefix)) return `for "${req.alwaysKey.slice(prefix.length)}"`;
  return `for all ${req.tool} calls this session`;
}

export function createApprover(io: IO, mode: ApprovalMode): Approver {
  const always = new Set<string>();

  const approver: Approver = {
    mode,
    setMode(next: ApprovalMode) {
      approver.mode = next;
    },
    async request(req: ApprovalRequest): Promise<ApprovalResult> {
      if (approver.mode === "yolo") return "allow";
      if (approver.mode === "readonly") return "readonly";
      if (always.has(req.alwaysKey)) return "allow";

      const question = `Allow ${req.tool}: ${req.summary} ? [y]es / [n]o / [a]lways ${alwaysLabel(req)}`;
      const text = req.detail ? `${req.detail}\n${question}` : question;
      const answer = await io.withPaused(() => io.confirm(text));
      if (answer === "a") {
        always.add(req.alwaysKey);
        return "allow";
      }
      return answer === "y" ? "allow" : "deny";
    },
    isSafeCommand,
  };
  return approver;
}
