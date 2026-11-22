// Light Markdown cleanup for model text in the terminal: markers become styling, not raw symbols.
import { t, bold } from "./theme.ts";

/** Format one complete line of model output. */
export function formatLine(line: string): string {
  const heading = line.match(/^(\s*)#{1,6}\s+(.*)$/);
  if (heading) return heading[1] + bold(t.ink(inline(heading[2]!)));
  const bullet = line.match(/^(\s*)[*+]\s+(.*)$/);
  if (bullet) return `${bullet[1]}- ${inline(bullet[2]!)}`;
  return inline(line);
}

function inline(s: string): string {
  return s
    .replace(/\s?—\s?/g, " - ")                                  // em dash: plain hyphen
    .replace(/`([^`]+)`/g, (_, code: string) => t.cyan(code))      // inline code: accent color, no backticks
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a?: string, b?: string) => bold(a ?? b ?? ""))
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1$2"); // *italics*: just the words
}
