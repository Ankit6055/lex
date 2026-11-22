// A small keypress decoder for raw-mode stdin. Unlike readline's, a lone Esc is reported
// immediately (readline waits 500ms, so Esc felt laggy and could merge with the next key).
import type { Key } from "./screen.ts";

export type KeyEvent = { str?: string; key: Key };

const CSI: Record<string, string> = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "tab",
  "1~": "home", "7~": "home", "4~": "end", "8~": "end", "3~": "delete", "2~": "insert",
  "5~": "pageup", "6~": "pagedown", "200~": "paste-start", "201~": "paste-end",
};

function ctrlKey(code: number): KeyEvent {
  switch (code) {
    case 13: return { str: "\r", key: { name: "return", sequence: "\r" } };
    case 10: return { str: "\n", key: { name: "enter", sequence: "\n" } };
    case 9: return { str: "\t", key: { name: "tab", sequence: "\t" } };
    case 127: case 8: return { key: { name: "backspace", sequence: String.fromCharCode(code) } };
    case 0: return { key: { name: "space", ctrl: true } };
    default: return { str: String.fromCharCode(code), key: { name: String.fromCharCode(code + 96), ctrl: true, sequence: String.fromCharCode(code) } };
  }
}

/** Decode one chunk of stdin data into key events. */
export function decodeKeys(data: string): KeyEvent[] {
  const out: KeyEvent[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i]!;
    if (ch === "\x1b") {
      const next = data[i + 1];
      if (next === undefined) { out.push({ key: { name: "escape", sequence: "\x1b" } }); i++; continue; }
      if (next === "[" || next === "O") {
        // CSI / SS3: ESC [ params final
        let j = i + 2;
        while (j < data.length && /[0-9;]/.test(data[j]!)) j++;
        const final = data[j] ?? "";
        const params = data.slice(i + 2, j);
        const seq = data.slice(i, j + 1);
        i = j + 1;
        const mods = params.includes(";") ? Number(params.split(";")[1]) - 1 : 0; // xterm: 1 + shift(1) + alt(2) + ctrl(4)
        const base = params.split(";")[0] ?? "";
        const name = final === "~" ? CSI[`${base}~`] : CSI[final];
        if (!name) continue;
        out.push({ key: { name, sequence: seq, shift: final === "Z" || !!(mods & 1), meta: !!(mods & 2), ctrl: !!(mods & 4) } });
        continue;
      }
      // ESC + key = alt/option + key
      i += 2;
      if (next === "\r") out.push({ str: "\r", key: { name: "return", meta: true, sequence: "\x1b\r" } });
      else if (next === "\x7f" || next === "\b") out.push({ key: { name: "backspace", meta: true, sequence: "\x1b\x7f" } });
      else if (next === "\x1b") { out.push({ key: { name: "escape", sequence: "\x1b" } }); i--; }
      else out.push({ str: next, key: { name: next.toLowerCase(), meta: true, sequence: `\x1b${next}` } });
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) { out.push(ctrlKey(code)); i++; continue; }
    // A run of printable text (keeps pasted text and multi-byte characters together).
    let j = i;
    while (j < data.length && data[j] !== "\x1b" && data.charCodeAt(j) >= 32 && data.charCodeAt(j) !== 127) j++;
    for (const c of data.slice(i, j)) out.push({ str: c, key: { name: c === " " ? "space" : c.toLowerCase(), sequence: c } });
    i = j;
  }
  return out;
}
