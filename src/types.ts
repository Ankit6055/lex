import type { Tool, LanguageModel } from "ai";

export type ApprovalMode = "ask" | "yolo" | "readonly";

export interface ApprovalRequest {
  tool: string;          // "bash" | "write" | "edit"
  summary: string;       // one line, e.g. `npm test` or `src/api.ts (+3 −1)`
  detail?: string;       // optional multi-line, e.g. a colored diff
  alwaysKey: string;     // what "always" remembers, e.g. "bash:npm test" or "edit"
}
export type ApprovalResult = "allow" | "deny" | "readonly";

export interface Approver {
  mode: ApprovalMode;
  setMode(mode: ApprovalMode): void;
  request(req: ApprovalRequest): Promise<ApprovalResult>;
  isSafeCommand(command: string): boolean;   // operator-aware allowlist
}

export interface IO {
  confirm(question: string): Promise<"y" | "n" | "a">;
  choose(question: string, options: string[]): Promise<string>; // allows free text
  prompt(label: string): Promise<string | null>;                // null on EOF / Ctrl-D
  secret(label: string): Promise<string>;                       // masked input for API keys
  withPaused<T>(fn: () => Promise<T>): Promise<T>;              // stops the spinner around prompts
  info(msg: string): void;                                      // dim line to stderr
}

export interface ToolContext {
  root: string;          // realpath of project root; all file access is confined here
  approver: Approver;
  io: IO;
  memoryPath: string;    // <root>/.lex/memory.md
}
export type ToolFactory = (ctx: ToolContext) => Tool;

export type ProviderId = string;   // a provider id from src/providers.ts (or a custom one in ~/.lex/config.json)
export interface ModelInfo { spec: string; provider: ProviderId; id: string }
export interface ResolvedModel extends ModelInfo { model: LanguageModel }

export interface PromptContext {
  cwd: string;
  os: string;
  date: string;
  toolNames: string[];
  gitBranch?: string;
  projectInstructions?: { file: string; content: string };
  memory?: string;
  skills?: { name: string; description: string }[];
}

export interface TurnUsage { steps: number; toolCalls: number; inputTokens: number; outputTokens: number; ms: number }
