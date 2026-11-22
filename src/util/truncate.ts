/** Keep the first `n` lines. Appends a notice (and optional hint) when lines were dropped. */
export function capLines(s: string, n: number, hint?: string): string {
  const lines = s.split("\n");
  if (lines.length <= n) return s;
  const kept = lines.slice(0, n).join("\n");
  const notice = `[truncated: showing ${n} of ${lines.length} lines${hint ? `. ${hint}` : ""}]`;
  return `${kept}\n${notice}`;
}

/** Keep the first `n` characters. */
export function capChars(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}\n[truncated: showing first ${n} of ${s.length} chars]`;
}

/** Keep the last `n` characters (errors usually show up at the end). */
export function capTail(s: string, n: number): string {
  if (s.length <= n) return s;
  return `[truncated: showing last ${n} of ${s.length} chars]\n${s.slice(s.length - n)}`;
}
