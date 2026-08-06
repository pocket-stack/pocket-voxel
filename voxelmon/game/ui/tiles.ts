// Named GB tile ids for the voxel ui layer (SCHEMA.md "UI tile ids — the
// GB VRAM convention"): the cooker packs fonts/font glyphs at their charmap
// codes (mainBase 0x80..0xff) and fonts/font_extra (borders, arrows) at
// extraBase 0x60..0x7f, so these constants ARE the uiTile/uiText codes.
//
// Border codes ground against gen1recomp src/render/Font.lua:401
// DEFAULT_BORDER (charmap.asm $79-$7E) — the frame TextBox.lua's drawBox
// draws; SPACE is Font.lua:198; the ▼ page-advance arrow is TextBox.lua:386
// (Theme.moreArrow or 0xEE) and ▶ the menu cursor glyph $ED.

// gen1recomp src/render/Font.lua:401 (charmap.asm $79-$7E)
export const BORDER_TL = 0x79;
export const BORDER_H = 0x7a;
export const BORDER_TR = 0x7b;
export const BORDER_V = 0x7c;
export const BORDER_BL = 0x7d;
export const BORDER_BR = 0x7e;
// gen1recomp src/render/Font.lua:198
export const SPACE = 0x7f;
// blinking page-advance ▼ (TextBox.lua:386, home/text.asm `ld a, "▼"`)
export const ARROW_MORE = 0xee;
// menu cursor ▶ / hollow ▷ (charmap.asm $ED/$EC)
export const ARROW_CURSOR = 0xed;
export const ARROW_HOLLOW = 0xec;

// font.json mainBase/extraBase — where the two glyph pages sit in the code
// space (SCHEMA.md; the cooker must satisfy this mapping).
export const FONT_BASE = 0x80;
export const EXTRA_BASE = 0x60;

// The dialogue box geometry (gen1recomp src/render/TextBox.lua:18): a
// 20x6-tile bordered window across the screen bottom, text on interior
// rows +2 and +4, 18 columns per line.
export const BOX_TX = 0;
export const BOX_TY = 12;
export const BOX_TW = 20;
export const BOX_TH = 6;
export const MAX_COLS = 18;
export const TEXT_X = BOX_TX + 1;
export const LINE1_Y = BOX_TY + 2;
export const LINE2_Y = BOX_TY + 4;
// blinking ▼ cell: pokered prints it at hlcoord 18,16 (home/text.asm
// .waitButton); the Lua draws the same glyph nudged -4px, which a tile
// grid cannot express, so the cell is the pokered one.
export const ARROW_X = 18;
export const ARROW_Y = 16;

// The English charmap (pokered charmap.asm via the importer's font.json;
// the JP kana block is omitted — it aliases the same code space and the
// extracted US text never contains it). Multi-char sequences (the
// apostrophe digraphs, the <...> control glyphs) are single glyphs on the
// GB, so encode matches them greedily before single chars — the same
// segmentation Font.split does.
const CHARMAP_PAIRS: [string, number][] = [
  ["<BOLD_A>", 0x60],
  ["<BOLD_B>", 0x61],
  ["<BOLD_C>", 0x62],
  ["<BOLD_D>", 0x63],
  ["<BOLD_E>", 0x64],
  ["<BOLD_F>", 0x65],
  ["<BOLD_G>", 0x66],
  ["<BOLD_H>", 0x67],
  ["<BOLD_I>", 0x68],
  ["<BOLD_L>", 0x6b],
  ["<BOLD_M>", 0x6c],
  ["<BOLD_P>", 0x72],
  ["<BOLD_S>", 0x6a],
  ["<BOLD_V>", 0x69],
  ["<COLON>", 0x6d],
  ["<DOT>", 0xf2],
  ["<ED>", 0xf0],
  ["<ID>", 0x73],
  ["<LV>", 0x6e],
  ["<MN>", 0xe2],
  ["<PK>", 0xe1],
  ["<to>", 0x70],
  ["'d", 0xbb],
  ["'l", 0xbc],
  ["'m", 0xe5],
  ["'r", 0xe4],
  ["'s", 0xbd],
  ["'t", 0xbe],
  ["'v", 0xbf],
  [" ", 0x7f],
  ["!", 0xe7],
  ['"', 0x73],
  ["'", 0xe0],
  ["(", 0x9a],
  [")", 0x9b],
  [",", 0xf4],
  ["-", 0xe3],
  [".", 0xe8],
  ["/", 0xf3],
  ["0", 0xf6],
  ["1", 0xf7],
  ["2", 0xf8],
  ["3", 0xf9],
  ["4", 0xfa],
  ["5", 0xfb],
  ["6", 0xfc],
  ["7", 0xfd],
  ["8", 0xfe],
  ["9", 0xff],
  [":", 0x9c],
  [";", 0x9d],
  ["?", 0xe6],
  ["A", 0x80],
  ["B", 0x81],
  ["C", 0x82],
  ["D", 0x83],
  ["E", 0x84],
  ["F", 0x85],
  ["G", 0x86],
  ["H", 0x87],
  ["I", 0x88],
  ["J", 0x89],
  ["K", 0x8a],
  ["L", 0x8b],
  ["M", 0x8c],
  ["N", 0x8d],
  ["O", 0x8e],
  ["P", 0x8f],
  ["Q", 0x90],
  ["R", 0x91],
  ["S", 0x92],
  ["T", 0x93],
  ["U", 0x94],
  ["V", 0x95],
  ["W", 0x96],
  ["X", 0x97],
  ["Y", 0x98],
  ["Z", 0x99],
  ["[", 0x9e],
  ["]", 0x9f],
  ["a", 0xa0],
  ["b", 0xa1],
  ["c", 0xa2],
  ["d", 0xa3],
  ["e", 0xa4],
  ["f", 0xa5],
  ["g", 0xa6],
  ["h", 0xa7],
  ["i", 0xa8],
  ["j", 0xa9],
  ["k", 0xaa],
  ["l", 0xab],
  ["m", 0xac],
  ["n", 0xad],
  ["o", 0xae],
  ["p", 0xaf],
  ["q", 0xb0],
  ["r", 0xb1],
  ["s", 0xb2],
  ["t", 0xb3],
  ["u", 0xb4],
  ["v", 0xb5],
  ["w", 0xb6],
  ["x", 0xb7],
  ["y", 0xb8],
  ["z", 0xb9],
  ["¥", 0xf0],
  ["·", 0x74],
  ["×", 0xf1],
  ["é", 0xba],
  ["‘", 0x70],
  ["’", 0x71],
  ["“", 0x72],
  ["”", 0x73],
  ["…", 0x75],
  ["′", 0x60],
  ["″", 0x61],
  ["№", 0x74],
  ["⋯", 0x75],
  ["─", 0x7a],
  ["│", 0x7c],
  ["┌", 0x79],
  ["┐", 0x7b],
  ["└", 0x7d],
  ["┘", 0x7e],
  ["▲", 0xed],
  ["▶", 0xed],
  ["▷", 0xec],
  ["▼", 0xee],
  ["♀", 0xf5],
  ["♂", 0xef],
];

const SINGLE = new Map<string, number>();
const MULTI: [string, number][] = [];
for (const [seq, code] of CHARMAP_PAIRS) {
  if ([...seq].length === 1) SINGLE.set(seq, code);
  else MULTI.push([seq, code]);
}
// greedy longest-match first
MULTI.sort((a, b) => b[0].length - a[0].length);

/**
 * MULTI bucketed by first character. The naive encoder scanned the whole
 * table at every character position; on the PSP's QuickJS (~1.7 us/op) a
 * 40-glyph dialogue line cost tens of milliseconds PER FRAME, which is what
 * made the typewriter crawl on real hardware. Buckets make the common case
 * (no digraph starts here) one Map lookup.
 */
const MULTI_BY_HEAD = new Map<string, [string, number][]>();
for (const entry of MULTI) {
  const head = entry[0][0]!;
  const bucket = MULTI_BY_HEAD.get(head);
  if (bucket) bucket.push(entry);
  else MULTI_BY_HEAD.set(head, [entry]);
}

/** encodeGlyphs memo: dialogue re-encodes the same handful of lines. */
const GLYPH_CACHE = new Map<string, number[]>();
const GLYPH_CACHE_MAX = 64;

/**
 * Segment a line into GB glyph codes — the port of Font.split + Font.encode
 * for the fixed-width vanilla page. Unknown characters fall back to SPACE
 * so pagination widths never drift on an unmapped char.
 */
export function encodeGlyphs(text: string): number[] {
  const hit = GLYPH_CACHE.get(text);
  if (hit) return hit;
  const out: number[] = [];
  let i = 0;
  outer: while (i < text.length) {
    const bucket = MULTI_BY_HEAD.get(text[i]!);
    if (bucket) {
      for (const [seq, code] of bucket) {
        if (text.startsWith(seq, i)) {
          out.push(code);
          i += seq.length;
          continue outer;
        }
      }
    }
    const cp = String.fromCodePoint(text.codePointAt(i)!);
    out.push(SINGLE.get(cp) ?? SPACE);
    i += cp.length;
  }
  if (GLYPH_CACHE.size >= GLYPH_CACHE_MAX) GLYPH_CACHE.clear();
  GLYPH_CACHE.set(text, out);
  return out;
}

/** Glyph count of a line — the pagination width unit (18 per line). */
export function glyphLen(text: string): number {
  return encodeGlyphs(text).length;
}

/**
 * Cut a string after `n` glyphs — the reveal boundary in source-string
 * space, used by tests to reason about uiReveal counts.
 */
export function sliceGlyphs(text: string, n: number): string {
  let i = 0;
  let count = 0;
  outer: while (i < text.length && count < n) {
    const bucket = MULTI_BY_HEAD.get(text[i]!);
    if (bucket) {
      for (const [seq] of bucket) {
        if (text.startsWith(seq, i)) {
          i += seq.length;
          count += 1;
          continue outer;
        }
      }
    }
    const cp = String.fromCodePoint(text.codePointAt(i)!);
    i += cp.length;
    count += 1;
  }
  return text.slice(0, i);
}
