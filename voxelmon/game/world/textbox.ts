// The lower dialogue box's pagination + typewriter STATE MACHINE. Ports
// gen1recomp src/render/TextBox.lua (:43 new, :108 paginate, :187 update);
// rendering becomes ui ops in the presentation frontend, which reads the
// view() this machine exposes.
//
// Text markers (from the extractor): \n = second line, \v (0x0B) = scroll
// one line up after a button wait (pokered <CONT>), \f = page break (wait
// for A, clear). {PLAYER}/{RIVAL} are substituted before display.

import {
  TEXT_PAGE_CLEAR,
  TEXT_PRE_ADVANCE,
  TEXT_SCROLL_PAIR,
} from "../rules/timing.ts";
import { glyphLen, MAX_COLS, sliceGlyphs } from "../ui/tiles.ts";
import type { Input } from "../input.ts";

export interface TextboxPage {
  lines: string[];
  /** contBefore[i]: line i was preceded by \v — button-wait then scroll. */
  contBefore: boolean[];
}

export interface ShownLine {
  /** The full source line (uiText's string arg). */
  text: string;
  /** Glyphs revealed so far (uiReveal's count). */
  revealed: number;
}

interface TokenContext {
  player?: string;
  rival?: string;
}

// TextBox.lua:80 TOKENS — the runtime tokens substitute() knows. The slice
// carries PLAYER/RIVAL; unknown tokens drop (the Lua returns nil).
export function substitute(text: string, ctx: TokenContext): string {
  return text.replace(/\{(\w+):?\w*\}/g, (_, token: string) => {
    if (token === "PLAYER") return ctx.player ?? "RED";
    if (token === "RIVAL") return ctx.rival ?? "BLUE";
    return "";
  });
}

// TextBox.lua:108 paginate — split marked-up text into pages of lines.
// \v-scrolled lines become additional lines on the same page. Soft-wrap on
// glyph boundaries at MAX_COLS glyphs, cutting back to the last space.
export function paginate(text: string, maxCols: number = MAX_COLS): TextboxPage[] {
  const pages: TextboxPage[] = [];
  const pushLine = (page: TextboxPage, line: string, wait: boolean) => {
    while (glyphLen(line) > maxCols) {
      let head = sliceGlyphs(line, maxCols);
      // TextBox.lua:126: cut falls back to the last space inside the fit
      const sp = head.lastIndexOf(" ");
      if (sp > 0) head = line.slice(0, sp + 1);
      page.lines.push(head);
      page.contBefore.push(wait);
      wait = false;
      line = line.slice(head.length);
    }
    page.lines.push(line);
    page.contBefore.push(wait);
  };
  for (const pageText of `${text}\f`.split("\f").slice(0, -1)) {
    if (pageText === "") continue;
    const page: TextboxPage = { lines: [], contBefore: [] };
    let pos = 0;
    let waitNext = false;
    for (;;) {
      const npos = pageText.slice(pos).search(/[\n\v]/);
      if (npos < 0) {
        pushLine(page, pageText.slice(pos), waitNext);
        break;
      }
      pushLine(page, pageText.slice(pos, pos + npos), waitNext);
      waitNext = pageText[pos + npos] === "\v";
      pos += npos + 1;
    }
    if (page.lines[page.lines.length - 1] === "") {
      page.lines.pop();
      page.contBefore.pop();
    }
    if (page.lines.length > 0) pages.push(page);
  }
  if (pages.length === 0) pages.push({ lines: [""], contBefore: [false] });
  return pages;
}

export class Textbox {
  readonly pages: TextboxPage[];
  pageIndex = 0;
  lineIndex = 0;
  charIndex = 0;
  /** Visible lines (max 2), full text + revealed glyph count. */
  shown: ShownLine[] = [];
  waiting = false;
  preWait = 0;
  contAdvance = false;
  holdFrames = 0;
  done = false;
  /** Set on the tick a/b pops the finished box; the owner state acts on it. */
  closed = false;
  blink = 0;
  private charTimer = 0;
  private lineGlyphs = 0;

  constructor(text: string, ctx: TokenContext = {}) {
    this.pages = paginate(substitute(text, ctx));
    this.beginLine();
  }

  private currentLine(): string {
    return this.pages[this.pageIndex].lines[this.lineIndex];
  }

  // TextBox.lua:177 beginLine
  private beginLine(): void {
    this.charIndex = 0;
    this.lineGlyphs = glyphLen(this.currentLine());
    if (this.shown.length >= 2) {
      this.shown.shift();
    }
    this.shown.push({ text: this.currentLine(), revealed: 0 });
  }

  // TextBox.lua:187 update — one call per fixed step.
  update(input: Input): void {
    this.blink = (this.blink + 1) % 60;
    // a page or CONT advance blocks the whole box while the original's
    // scroll and clear run; nothing types and no input is read
    if (this.holdFrames > 0) {
      this.holdFrames -= 1;
      return;
    }
    if (this.done) {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        this.closed = true;
      }
      return;
    }
    if (this.waiting) {
      // TextBox.lua:279: the ▼ is up for TEXT_PRE_ADVANCE frames that
      // swallow the button (ProtectedDelay3 before ManualTextScroll)
      if (this.preWait > 0) {
        this.preWait -= 1;
        return;
      }
      if (input.wasPressed("a") || input.wasPressed("b")) {
        this.waiting = false;
        if (this.contAdvance) {
          // ContText / ManualTextScroll: keep the box, scroll one line;
          // ScrollTextUpOneLine is "always called twice in a row"
          this.contAdvance = false;
          this.lineIndex += 1;
          this.beginLine();
          this.holdFrames = TEXT_SCROLL_PAIR;
        } else {
          this.shown = [];
          this.pageIndex += 1;
          this.lineIndex = 0;
          this.beginLine();
          // ClearScreenArea then DelayFrames 20 before the next page types
          this.holdFrames = TEXT_PAGE_CLEAR;
        }
      }
      return;
    }
    // TextBox.lua:306 typewriter cadence: one glyph every N frames, N = the
    // OPTION text speed (default 3); holding A/B prints every frame
    let delay = 3;
    if (input.isDown("a") || input.isDown("b")) delay = 1;
    this.charTimer += 1;
    while (this.charTimer >= delay) {
      this.charTimer -= delay;
      if (this.charIndex < this.lineGlyphs) {
        this.charIndex += 1;
        this.shown[this.shown.length - 1].revealed = this.charIndex;
      } else {
        // line finished
        const page = this.pages[this.pageIndex];
        if (this.lineIndex < page.lines.length - 1) {
          const nextIdx = this.lineIndex + 1;
          if (page.contBefore[nextIdx]) {
            // pokered <CONT>: ▼ + button wait before scroll
            this.waiting = true;
            this.preWait = TEXT_PRE_ADVANCE;
            this.contAdvance = true;
          } else {
            this.lineIndex = nextIdx;
            this.beginLine();
          }
        } else if (this.pageIndex < this.pages.length - 1) {
          this.waiting = true;
          this.preWait = TEXT_PRE_ADVANCE;
          this.contAdvance = false;
        } else {
          this.done = true;
        }
        break;
      }
    }
  }

  // TextBox.lua:381 — the blinking ▼ shows while waiting for an advance or
  // (finished box) a close press, on the first half of the blink cycle.
  arrowVisible(): boolean {
    return (this.waiting || this.done) && this.blink < 30;
  }
}
