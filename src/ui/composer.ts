// The chat composer: a multi-line editor between two rules, with history and autocomplete
// for slash commands ("/") and files ("@").
import type { Key } from "./screen.ts";
import { t, bar, bold } from "./theme.ts";
import { pad, truncate, width, wrapPlain } from "./text.ts";

export interface MenuItem { label: string; hint?: string; insert: string; run?: boolean }
export interface Menu { items: MenuItem[]; sel: number; from: number }

export interface ComposerHooks {
  /** Suggestions for the text before the caret, or null for no menu. */
  suggest(before: string): { items: MenuItem[]; from: number } | null;
  submit(text: string): void;
}

const isPrintable = (str: string | undefined, key: Key) =>
  !!str && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str);

export class Composer {
  text = "";
  cursor = 0;
  menu: Menu | null = null;
  private history: string[];
  private histIdx: number;
  private draft = "";
  private pasting = false;

  constructor(private hooks: ComposerHooks, history: string[] = []) {
    this.history = history;
    this.histIdx = history.length;
  }

  setText(s: string): void {
    this.text = s;
    this.cursor = s.length;
    this.refreshMenu();
  }

  clear(): void {
    this.setText("");
    this.histIdx = this.history.length;
  }

  private insert(s: string): void {
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor);
    this.cursor += s.length;
    this.refreshMenu();
  }

  private refreshMenu(): void {
    const prev = this.menu;
    const s = this.hooks.suggest(this.text.slice(0, this.cursor));
    this.menu = s && s.items.length ? { ...s, sel: prev && prev.from === s.from ? Math.min(prev.sel, s.items.length - 1) : 0 } : null;
  }

  private applyMenu(): MenuItem | undefined {
    if (!this.menu) return;
    const item = this.menu.items[this.menu.sel];
    if (!item) return;
    this.text = this.text.slice(0, this.menu.from) + item.insert + this.text.slice(this.cursor);
    this.cursor = this.menu.from + item.insert.length;
    this.menu = null;
    return item;
  }

  private lineBounds(): { start: number; end: number } {
    const start = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
    const nl = this.text.indexOf("\n", this.cursor);
    return { start, end: nl < 0 ? this.text.length : nl };
  }

  private wordLeft(): number {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.text[i - 1]!)) i--;
    while (i > 0 && !/\s/.test(this.text[i - 1]!)) i--;
    return i;
  }

  private wordRight(): number {
    let i = this.cursor;
    while (i < this.text.length && /\s/.test(this.text[i]!)) i++;
    while (i < this.text.length && !/\s/.test(this.text[i]!)) i++;
    return i;
  }

  private submit(): void {
    const text = this.text.replace(/\s+$/, "");
    if (!text.trim()) return;
    if (this.history[this.history.length - 1] !== text) this.history.push(text);
    this.clear();
    this.hooks.submit(text);
  }

  /** Handle a key; returns false if it wasn't for the composer (the app then handles it). */
  onKey(str: string | undefined, key: Key): boolean {
    if (key.name === "paste-start") { this.pasting = true; return true; }
    if (key.name === "paste-end") { this.pasting = false; return true; }
    if (this.pasting) {
      if (key.name === "return" || key.name === "enter") this.insert("\n");
      else if (str) this.insert(str.replace(/\r\n?/g, "\n"));
      return true;
    }

    if (this.menu) {
      if (key.name === "up") { this.menu.sel = (this.menu.sel - 1 + this.menu.items.length) % this.menu.items.length; return true; }
      if (key.name === "down") { this.menu.sel = (this.menu.sel + 1) % this.menu.items.length; return true; }
      if (key.name === "tab" && !key.shift) { this.applyMenu(); this.refreshMenu(); return true; }
      if (key.name === "return" && !key.meta) {
        const item = this.applyMenu();
        if (item?.run) this.submit(); else this.refreshMenu();
        return true;
      }
      if (key.name === "escape") { this.menu = null; return true; }
    }

    const { start, end } = this.lineBounds();
    switch (key.name) {
      case "return":
        if (key.meta) { this.insert("\n"); return true; }                      // option/alt+enter
        if (this.text[this.cursor - 1] === "\\") {                             // backslash + enter
          this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
          this.cursor--;
          this.insert("\n");
          return true;
        }
        this.submit();
        return true;
      case "enter": this.insert("\n"); return true;                             // ctrl+j
      case "backspace":
        if (key.meta || (key.ctrl && key.name === "backspace")) { const w = this.wordLeft(); this.text = this.text.slice(0, w) + this.text.slice(this.cursor); this.cursor = w; }
        else if (this.cursor > 0) { this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor); this.cursor--; }
        this.refreshMenu();
        return true;
      case "delete":
        this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
        this.refreshMenu();
        return true;
      case "left": this.cursor = key.meta || key.ctrl ? this.wordLeft() : Math.max(0, this.cursor - 1); this.refreshMenu(); return true;
      case "right": this.cursor = key.meta || key.ctrl ? this.wordRight() : Math.min(this.text.length, this.cursor + 1); this.refreshMenu(); return true;
      case "home": this.cursor = start; return true;
      case "end": this.cursor = end; return true;
      case "up":
        if (start === 0) return this.historyStep(-1);
        { const col = this.cursor - start; const prevStart = this.text.lastIndexOf("\n", start - 2) + 1; this.cursor = Math.min(prevStart + col, start - 1); }
        return true;
      case "down":
        if (end === this.text.length) return this.historyStep(1);
        { const col = this.cursor - start; const nextEnd = this.text.indexOf("\n", end + 1); this.cursor = Math.min(end + 1 + col, nextEnd < 0 ? this.text.length : nextEnd); }
        return true;
    }
    if (key.ctrl) {
      switch (key.name) {
        case "a": this.cursor = start; return true;
        case "e": this.cursor = end; return true;
        case "b": this.cursor = Math.max(0, this.cursor - 1); return true;
        case "f": this.cursor = Math.min(this.text.length, this.cursor + 1); return true;
        case "u": this.text = this.text.slice(0, start) + this.text.slice(this.cursor); this.cursor = start; this.refreshMenu(); return true;
        case "k": this.text = this.text.slice(0, this.cursor) + this.text.slice(end); this.refreshMenu(); return true;
        case "w": { const w = this.wordLeft(); this.text = this.text.slice(0, w) + this.text.slice(this.cursor); this.cursor = w; this.refreshMenu(); return true; }
      }
      return false;
    }
    if (key.meta) {
      if (key.name === "b") { this.cursor = this.wordLeft(); return true; }
      if (key.name === "f") { this.cursor = this.wordRight(); return true; }
      return false;
    }
    if (key.name === "tab" || key.name === "escape") return false;
    if (isPrintable(str, key)) { this.insert(str!); return true; }
    return false;
  }

  private historyStep(dir: -1 | 1): boolean {
    if (!this.history.length) return false;
    if (this.histIdx === this.history.length) this.draft = this.text;
    const next = Math.min(this.history.length, Math.max(0, this.histIdx + dir));
    if (next === this.histIdx) return true;
    this.histIdx = next;
    this.text = next === this.history.length ? this.draft : this.history[next]!;
    this.cursor = this.text.length;
    this.menu = null;
    return true;
  }

  /** The composer block: rule, prompt rows, rule. Cursor is relative to the first returned line. */
  render(cols: number, placeholder: string): { lines: string[]; cursor: { row: number; col: number } } {
    const rule = t.hair("─".repeat(cols - 1));
    const inner = cols - 4;
    const lines = [rule];
    let cursor = { row: 1, col: 2 };
    if (!this.text) {
      lines.push(`${t.ink("❯")} ${t.shade(truncate(placeholder, inner))}`);
    } else {
      const rows = wrapPlain(this.text, inner);
      rows.forEach((r, i) => lines.push(`${i === 0 ? t.ink("❯") : " "} ${r.text}`));
      // The caret belongs to the last row that starts at or before it.
      for (let i = rows.length - 1; i >= 0; i--) {
        if (this.cursor >= rows[i]!.start) { cursor = { row: 1 + i, col: 2 + width(this.text.slice(rows[i]!.start, this.cursor)) }; break; }
      }
    }
    lines.push(rule);
    return { lines, cursor };
  }

  /** Autocomplete rows shown under the composer. */
  renderMenu(cols: number): string[] {
    if (!this.menu) return [];
    const max = 8;
    const { items, sel } = this.menu;
    const top = Math.max(0, Math.min(sel - max + 1, items.length - max));
    const shown = items.slice(Math.max(0, top), Math.max(0, top) + max);
    const labelW = Math.min(Math.max(...shown.map((i) => width(i.label))) + 3, Math.floor(cols / 2));
    return shown.map((item, k) => {
      const on = Math.max(0, top) + k === sel;
      const label = on ? bold(t.ink(item.label)) : t.mist(item.label);
      return `${on ? bar(k, shown.length) : " "} ${pad(label, labelW)} ${t.shade(truncate(item.hint ?? "", cols - labelW - 5))}`;
    });
  }
}
