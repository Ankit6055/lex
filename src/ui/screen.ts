// The interactive terminal: a live region redrawn in place at the bottom (composer, spinner,
// dialogs) with permanent output printed above it, plus keypress routing to whoever has focus.
import { truncate, width, wrapPlain } from "./text.ts";
import { decodeKeys } from "./keys.ts";

export interface Key { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string }
export type KeyHandler = (str: string | undefined, key: Key) => void;

/** What the live region shows: its lines, and where the caret sits (if it should be visible). */
export interface View { lines: string[]; cursor?: { row: number; col: number } }

export class Screen {
  private rows = 0;          // rows currently drawn in the live region
  private caretRow = 0;      // row (within the region) where the terminal cursor sits
  private partial = "";      // streamed text not yet ended by a newline
  /** Prefix for soft-wrapped continuation rows of streamed text (e.g. "  " under a "● " bullet). */
  wrapIndent = "";
  private handlers: KeyHandler[] = [];
  private view: () => View = () => ({ lines: [] });
  private started = false;
  private readonly out = process.stdout;
  private readonly stdin = process.stdin;

  private onData = (data: Buffer | string) => {
    for (const { str, key } of decodeKeys(data.toString())) this.handlers[this.handlers.length - 1]?.(str, key);
  };
  private onResize = () => this.render();
  private restore = () => {
    if (!this.started) return;
    this.out.write("\x1b[?25h\x1b[?2004l");
    try { this.stdin.setRawMode(false); } catch { /* ignore */ }
  };

  get cols(): number {
    return Math.max(20, this.out.columns || 80);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stdin.setRawMode(true);
    this.stdin.setEncoding("utf8");
    this.stdin.resume();
    this.stdin.on("data", this.onData);
    this.out.on("resize", this.onResize);
    this.out.write("\x1b[?2004h"); // bracketed paste
    process.on("exit", this.restore);
  }

  stop(): void {
    if (!this.started) return;
    this.flushText();
    this.erase();
    this.out.write("\x1b[?25h\x1b[?2004l");
    this.stdin.off("data", this.onData);
    this.out.off("resize", this.onResize);
    try { this.stdin.setRawMode(false); } catch { /* ignore */ }
    this.stdin.pause();
    process.off("exit", this.restore);
    this.started = false;
  }

  /** Give the terminal back (e.g. to an editor or a long-running subcommand), then take it again. */
  async suspend<T>(fn: () => Promise<T>): Promise<T> {
    this.stop();
    try {
      return await fn();
    } finally {
      this.start();
      this.render();
    }
  }

  /** Route keys to `h` until the returned function is called. */
  pushKeys(h: KeyHandler): () => void {
    this.handlers.push(h);
    return () => {
      const i = this.handlers.lastIndexOf(h);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  setView(view: () => View): void {
    this.view = view;
    this.render();
  }

  private eraseSeq(): string {
    if (!this.rows) return "";
    return "\r" + (this.caretRow > 0 ? `\x1b[${this.caretRow}A` : "") + "\x1b[J";
  }

  private erase(): void {
    this.out.write(this.eraseSeq());
    this.rows = 0;
    this.caretRow = 0;
  }

  /** Redraw the live region in place. */
  render(): void {
    if (!this.started) return;
    const v = this.view();
    const max = this.cols - 1;
    const head = this.partial ? [this.partial] : [];
    const lines = [...head, ...v.lines].map((l) => truncate(l, max));
    let buf = "\x1b[?25l" + this.eraseSeq() + lines.join("\r\n");
    this.rows = lines.length;
    this.caretRow = Math.max(0, lines.length - 1);
    if (v.cursor && lines.length) {
      const row = v.cursor.row + head.length;
      const up = lines.length - 1 - row;
      buf += (up > 0 ? `\x1b[${up}A` : "") + "\r" + (v.cursor.col > 0 ? `\x1b[${v.cursor.col}C` : "") + "\x1b[?25h";
      this.caretRow = row;
    }
    this.out.write(buf);
  }

  /** Print permanent output above the live region. */
  print(text: string): void {
    if (!this.started) { this.out.write(text.endsWith("\n") ? text : text + "\n"); return; }
    this.out.write("\x1b[?25l" + this.eraseSeq() + (text.endsWith("\n") ? text : text + "\n"));
    this.rows = 0;
    this.caretRow = 0;
    this.render();
  }

  /** Stream model text: complete lines go to scrollback, the unfinished line stays in the live region. */
  streamText(delta: string): void {
    this.partial += delta;
    const done: string[] = [];
    let nl: number;
    while ((nl = this.partial.indexOf("\n")) >= 0) {
      done.push(this.partial.slice(0, nl));
      this.partial = this.partial.slice(nl + 1);
    }
    const max = this.cols - 1;
    if (width(this.partial) > max) {
      const rows = wrapPlain(this.partial, max);
      done.push(...rows.slice(0, -1).map((r) => r.text.trimEnd()));
      this.partial = this.wrapIndent + rows[rows.length - 1]!.text;
    }
    if (done.length) this.print(done.join("\n") + "\n"); // explicit newline keeps blank lines (paragraph breaks)
    else this.render();
  }

  /** End any unfinished streamed line. */
  flushText(): void {
    if (!this.partial) return;
    const line = this.partial;
    this.partial = "";
    this.print(line);
  }

  get streaming(): boolean {
    return this.partial.length > 0;
  }
}
