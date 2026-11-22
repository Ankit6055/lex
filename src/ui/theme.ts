// lex's terminal theme: quiet charcoal-and-hairline UI with one iridescent accent.
// Truecolor when the terminal supports it, 256 colors otherwise, plain text with NO_COLOR.

type RGB = [number, number, number];

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export const palette = {
  ink: hex("#ECEAE4"),      // primary text, headings
  mist: hex("#8C8A85"),     // secondary text, labels
  shade: hex("#5E5C58"),    // placeholders, hints
  hairline: hex("#3A3936"), // rules and grid lines
  aqua: hex("#8FD9C3"),     // success
  gold: hex("#E6D38A"),     // accept-edits mode, warnings
  coral: hex("#F08F86"),    // bypass mode, errors, removals
  cyan: hex("#7FD3E6"),     // plan mode, info
};

/** The iridescent accent: cyan → aqua → pale gold → peach → pink. */
const HOLO: RGB[] = ["#7FD3E6", "#A8E0D8", "#E6E1A6", "#F0B2A2", "#E79AA8"].map(hex);

const env = process.env;
export const colorLevel: 0 | 1 | 2 = env.NO_COLOR || env.TERM === "dumb"
  ? 0
  : /truecolor|24bit/i.test(env.COLORTERM ?? "") || /iTerm|WezTerm|vscode|ghostty|Hyper/i.test(env.TERM_PROGRAM ?? "") || env.KITTY_WINDOW_ID
    ? 2
    : 1;

function to256([r, g, b]: RGB): number {
  const c = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * c(r) + 6 * c(g) + c(b);
}

export function fg(rgb: RGB, s: string): string {
  if (!colorLevel || !s) return s;
  const code = colorLevel === 2 ? `38;2;${rgb[0]};${rgb[1]};${rgb[2]}` : `38;5;${to256(rgb)}`;
  return `\x1b[${code}m${s}\x1b[39m`;
}

export const bold = (s: string) => (colorLevel ? `\x1b[1m${s}\x1b[22m` : s);
export const inverse = (s: string) => (colorLevel ? `\x1b[7m${s}\x1b[27m` : s);

export const t = {
  ink: (s: string) => fg(palette.ink, s),
  mist: (s: string) => fg(palette.mist, s),
  shade: (s: string) => fg(palette.shade, s),
  hair: (s: string) => fg(palette.hairline, s),
  aqua: (s: string) => fg(palette.aqua, s),
  gold: (s: string) => fg(palette.gold, s),
  coral: (s: string) => fg(palette.coral, s),
  cyan: (s: string) => fg(palette.cyan, s),
};

/** Color at position `p` (0..1) along the holographic gradient. */
export function holoAt(p: number): RGB {
  const x = Math.min(0.9999, Math.max(0, p)) * (HOLO.length - 1);
  const i = Math.floor(x), f = x - i;
  const a = HOLO[i]!, b = HOLO[i + 1]!;
  return [0, 1, 2].map((k) => Math.round(a[k]! + (b[k]! - a[k]!) * f)) as RGB;
}

/** Paint each character of `s` along the gradient (offset shifts it, e.g. per row for a diagonal sheen). */
export function holo(s: string, offset = 0, span = s.length): string {
  if (!colorLevel) return s;
  return [...s].map((ch, i) => (ch === " " ? ch : fg(holoAt((i + offset) / Math.max(1, span)), ch))).join("");
}

/** The signature vertical bar: marks where attention is (selected row, an open dialog). */
export const bar = (row = 0, rows = 1) => fg(holoAt(rows <= 1 ? 0.15 : row / (rows - 1)), "▌");

// Quadrant-block wordmark. The X uses ▜▙/▟▛ so its diagonals read cleanly at 5 rows.
const WORDMARK = [
  "██       ██████   ▜▙   ▟▛",
  "██       ██        ▜▙ ▟▛ ",
  "██       █████      ▐█▌  ",
  "██       ██        ▟▛ ▜▙ ",
  "██████   ██████   ▟▛   ▜▙",
];

export function wordmark(): string[] {
  const span = WORDMARK[0]!.length + WORDMARK.length;
  return WORDMARK.map((row, r) => holo(row, r, span));
}

/** Spinner frames, echoing the starburst mark; each frame takes the next gradient color. */
const FRAMES = ["·", "∗", "✳", "✴", "✳", "∗"];
export function spinnerFrame(n: number): string {
  return fg(holoAt((n % 24) / 24), FRAMES[n % FRAMES.length]!);
}
