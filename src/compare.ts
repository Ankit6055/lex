export interface CompareOptions { root: string; models: string[]; task: string; diff?: boolean; maxSteps?: number }

/** Same task on N models in temp copies. Implemented in Phase 3A. */
export async function runCompare(_o: CompareOptions): Promise<void> {
  throw new Error("compare lands in Phase 3A");
}
