import type { ApprovalMode } from "./types.ts";

export interface ReplOptions { root: string; model?: string; mode: ApprovalMode; maxSteps?: number }

/** Interactive multi-turn loop. Implemented in Phase 2. */
export async function runRepl(_o: ReplOptions): Promise<void> {
  throw new Error("The interactive REPL lands in Phase 2. For now, pass a prompt: lexcode \"your task\"");
}
