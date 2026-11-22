// Panels that take over the bottom of the screen: pickers, text inputs and the approval dialog.
import type { Key, View } from "./screen.ts";
import { t, bar, bold, holo } from "./theme.ts";
import { pad, truncate, width } from "./text.ts";

export interface Panel {
  render(cols: number): View;
  onKey(str: string | undefined, key: Key): void;
}

const isPrintable = (str: string | undefined, key: Key) =>
  !!str && !key.ctrl && !key.meta && str.length >= 1 && !/[\x00-\x1f\x7f]/.test(str);

// ─── List picker (single or multi-select, optional type-to-search) ────────────────────────────────

export interface Item<T> { label: string; value: T; hint?: string; group?: string }

export interface ListOptions<T> {
  title: string;
  subtitle?: string;
  items: Item<T>[];
  multi?: boolean;
  search?: boolean;
  current?: T;          // marked with a check
  preselected?: T[];    // multi: initially checked
  minSelected?: number; // multi: required count before enter works
  maxRows?: number;
}

export class ListPanel<T> implements Panel {
  private query = "";
  private sel = 0;
  private top = 0;
  private checked: Set<T>;
  private note = "";
  constructor(private o: ListOptions<T>, private done: (v: T | T[] | null) => void) {
    this.checked = new Set(o.preselected ?? []);
    const cur = o.items.findIndex((i) => i.value === o.current);
    if (cur >= 0) this.sel = cur;
  }

  private filtered(): Item<T>[] {
    const q = this.query.toLowerCase().trim();
    if (!q) return this.o.items;
    const terms = q.split(/\s+/);
    return this.o.items.filter((i) => terms.every((term) => `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(term)));
  }

  render(cols: number): View {
    const items = this.filtered();
    const maxRows = this.o.maxRows ?? 10;
    if (this.sel >= items.length) this.sel = Math.max(0, items.length - 1);
    if (this.sel < this.top) this.top = this.sel;
    if (this.sel >= this.top + maxRows) this.top = this.sel - maxRows + 1;
    const lines: string[] = [t.hair("─".repeat(cols - 1))];
    const count = this.o.multi ? t.mist(`  ${this.checked.size} selected`) : "";
    lines.push(` ${bold(t.ink(this.o.title))}${this.o.subtitle ? t.mist(`  ${this.o.subtitle}`) : ""}${count}`);
    let cursor: View["cursor"];
    if (this.o.search) {
      cursor = { row: lines.length, col: 3 + width(this.query) };
      lines.push(` ${t.mist("⌕")} ${this.query ? t.ink(this.query) : t.shade("type to search")}`);
    }
    if (!items.length) lines.push(t.shade("   no matches"));
    const visible = items.slice(this.top, this.top + maxRows);
    const labelW = Math.min(Math.max(...visible.map((i) => width(i.label)), 10) + 2, cols - 20);
    visible.forEach((item, k) => {
      const i = this.top + k;
      const on = i === this.sel;
      const mark = this.o.multi ? (this.checked.has(item.value) ? holo("◆") : t.shade("◇")) + " " : "";
      const check = item.value === this.o.current ? t.aqua(" ✓") : "";
      const label = on ? bold(t.ink(item.label)) : t.mist(item.label);
      const hint = item.hint ? t.shade(item.hint) : "";
      lines.push(`${on ? bar(k, visible.length) : " "} ${mark}${pad(label + check, labelW)} ${truncate(hint, cols - labelW - 8)}`);
    });
    if (items.length > this.top + maxRows) lines.push(t.shade(`   ↓ ${items.length - this.top - maxRows} more`));
    const keys = this.o.multi
      ? "space select · enter confirm · esc cancel"
      : "↑↓ move · enter select · esc cancel";
    lines.push(t.shade(` ${keys}`) + (this.note ? "  " + t.gold(this.note) : ""));
    return { lines, cursor };
  }

  onKey(str: string | undefined, key: Key): void {
    const items = this.filtered();
    this.note = "";
    switch (key.name) {
      case "up": this.sel = (this.sel - 1 + items.length) % Math.max(1, items.length); return;
      case "down": this.sel = (this.sel + 1) % Math.max(1, items.length); return;
      case "pageup": this.sel = Math.max(0, this.sel - (this.o.maxRows ?? 10)); return;
      case "pagedown": this.sel = Math.min(items.length - 1, this.sel + (this.o.maxRows ?? 10)); return;
      case "escape": this.done(null); return;
      case "return": {
        if (this.o.multi) {
          if (this.checked.size === 0 && items[this.sel]) this.checked.add(items[this.sel]!.value);
          if (this.checked.size < (this.o.minSelected ?? 1)) { this.note = `pick at least ${this.o.minSelected}`; return; }
          this.done([...this.checked]);
        } else if (items[this.sel]) this.done(items[this.sel]!.value);
        return;
      }
      case "backspace": this.query = this.query.slice(0, -1); this.sel = 0; this.top = 0; return;
    }
    if (key.ctrl && key.name === "c") { this.done(null); return; }
    if (this.o.multi && (key.name === "space" || str === " ") && items[this.sel]) {
      const v = items[this.sel]!.value;
      if (this.checked.has(v)) this.checked.delete(v); else this.checked.add(v);
      return;
    }
    if (this.o.search && isPrintable(str, key)) { this.query += str; this.sel = 0; this.top = 0; }
  }
}

// ─── Text input (free-text answers, API keys) ─────────────────────────────────────────────────────

export class InputPanel implements Panel {
  private value = "";
  constructor(private o: { title: string; subtitle?: string; mask?: boolean; placeholder?: string }, private done: (v: string | null) => void) {}

  render(cols: number): View {
    const shown = this.o.mask ? "•".repeat(this.value.length) : this.value;
    const lines = [
      t.hair("─".repeat(cols - 1)),
      ` ${bold(t.ink(this.o.title))}${this.o.subtitle ? t.mist(`  ${this.o.subtitle}`) : ""}`,
      ` ${t.ink("❯")} ${shown ? t.ink(shown) : t.shade(this.o.placeholder ?? "")}`,
      t.shade(" enter submit · esc cancel"),
    ];
    return { lines, cursor: { row: 2, col: 3 + width(shown) } };
  }

  onKey(str: string | undefined, key: Key): void {
    if (key.name === "return") return this.done(this.value);
    if (key.name === "escape" || (key.ctrl && key.name === "c")) return this.done(null);
    if (key.name === "backspace") { this.value = this.value.slice(0, -1); return; }
    if (key.ctrl && key.name === "u") { this.value = ""; return; }
    if (isPrintable(str, key) || key.name === "paste-start" || key.name === "paste-end") {
      if (str && isPrintable(str, key)) this.value += str;
    }
  }
}

// ─── Approval dialog ──────────────────────────────────────────────────────────────────────────────

export interface ApprovalView { tool: string; summary: string; detail?: string; alwaysLabel: string }

const TITLES: Record<string, string> = { bash: "Run command", write: "Write file", edit: "Edit file" };

export class ApprovalPanel implements Panel {
  private sel = 0;
  constructor(private req: ApprovalView, private done: (v: "y" | "a" | "n") => void) {}

  private options(): { label: string; value: "y" | "a" | "n"; key: string }[] {
    return [
      { label: "Yes", value: "y", key: "1" },
      { label: `Yes, and don't ask again ${this.req.alwaysLabel}`, value: "a", key: "2" },
      { label: "No, and tell lex what to do differently", value: "n", key: "3" },
    ];
  }

  render(cols: number): View {
    const body: string[] = [];
    body.push(bold(t.ink(TITLES[this.req.tool] ?? this.req.tool)));
    body.push("");
    body.push(`  ${t.ink(this.req.summary)}`);
    if (this.req.detail) {
      const detail = this.req.detail.split("\n");
      for (const l of detail.slice(0, 14)) body.push(`  ${l}`);
      if (detail.length > 14) body.push(t.shade(`  … ${detail.length - 14} more lines`));
    }
    body.push("");
    body.push(t.mist("Do you want to proceed?"));
    this.options().forEach((o, i) => {
      const on = i === this.sel;
      const text = `${o.key}. ${o.label}`;
      body.push(`${on ? t.ink("❯") : " "} ${on ? bold(t.ink(text)) : t.mist(text)}${o.value === "n" ? t.shade("  esc") : ""}`);
    });
    const lines = [t.hair("─".repeat(cols - 1)), ...body.map((l, i) => `${bar(i, body.length)} ${truncate(l, cols - 4)}`)];
    return { lines };
  }

  onKey(str: string | undefined, key: Key): void {
    const opts = this.options();
    if (key.name === "up") this.sel = (this.sel + opts.length - 1) % opts.length;
    else if (key.name === "down" || key.name === "tab") this.sel = (this.sel + 1) % opts.length;
    else if (key.name === "return") this.done(opts[this.sel]!.value);
    else if (key.name === "escape" || (key.ctrl && key.name === "c")) this.done("n");
    else if (str && /^[123]$/.test(str)) this.done(opts[Number(str) - 1]!.value);
    else if (str === "y") this.done("y");
    else if (str === "n") this.done("n");
  }
}
