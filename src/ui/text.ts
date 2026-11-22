// Terminal text helpers: ANSI-aware width, truncation and wrapping.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** Columns a code point occupies: 0 for combining marks, 2 for wide (CJK, emoji), else 1. */
function charWidth(cp: number): number {
  if (cp === 0 || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

export function width(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Cut `s` to at most `max` columns, keeping ANSI codes intact and appending `…` when cut. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (width(s) <= max) return s;
  let out = "", w = 0, i = 0;
  while (i < s.length) {
    ANSI.lastIndex = i;
    const m = ANSI.exec(s);
    if (m && m.index === i) { out += m[0]; i += m[0].length; continue; }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max - 1) break;
    out += ch; w += cw; i += ch.length;
  }
  return out + "…\x1b[0m";
}

/** Pad with spaces to exactly `cols` visible columns (truncating if longer). */
export function pad(s: string, cols: number): string {
  const t = truncate(s, cols);
  return t + " ".repeat(Math.max(0, cols - width(t)));
}

/**
 * Split plain text (no ANSI) into rows of at most `cols` columns, breaking at spaces when possible.
 * Returns each row and the string index where it starts, so a caret can be mapped onto rows.
 */
export function wrapPlain(text: string, cols: number): { text: string; start: number }[] {
  const rows: { text: string; start: number }[] = [];
  let lineStart = 0;
  for (const line of text.split("\n")) {
    let i = 0;
    if (line.length === 0) rows.push({ text: "", start: lineStart });
    while (i < line.length) {
      let w = 0, j = i, lastSpace = -1;
      while (j < line.length) {
        const ch = String.fromCodePoint(line.codePointAt(j)!);
        const cw = charWidth(ch.codePointAt(0)!);
        if (w + cw > cols) break;
        if (ch === " ") lastSpace = j;
        w += cw; j += ch.length;
      }
      if (j < line.length && lastSpace > i) j = lastSpace + 1; // break after the last space that fits
      rows.push({ text: line.slice(i, j), start: lineStart + i });
      i = j;
    }
    lineStart += line.length + 1;
  }
  return rows;
}
