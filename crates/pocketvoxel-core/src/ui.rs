//! Screen-space UI draw-list construction: the scaled GB tile layer followed
//! by the native-pixel rectangle/5x7-label overlay.
//!
//! The 160x144 GB frame scales to fit 480x272 by height: **scale = VIEW_H /
//! GB_H = 272/144 ≈ 1.8889**, centered horizontally (the scaled UI is
//! ~302 px wide, leaving ~89 px pillars either side that show the diorama).
//! No integer scale fits, and shrinking to an integer would waste the
//! screen; the sim and GE both sample nearest-neighbour at this scale, so
//! the two hosts stay pixel-identical.
//!
//! Glyph resolution (`uiText`): each char resolves through the pak's CMAP
//! (cooked GB charmap → UI atlas tile). Characters the pak has no glyph for
//! draw nothing but still advance the pen and count toward the reveal cap —
//! spaces work without a CMAP entry. `\n` returns the pen to the starting
//! column one row down and is free (it does not count toward `uiReveal`).
//! Text draws after the tile grid, so it composites over box art at the
//! same cells.

use alloc::vec::Vec;

use crate::draw::Item;
use crate::pak::Pak;
use crate::scene::{Scene, UI_OVERLAY_RECTS_MAX, UiOverlayItem};
use crate::spec::{GB_H, GB_W, TILE_PX, UI_COLS, UI_ROWS, VIEW_H, VIEW_W, atlas_kind};

/// GB → screen scale, pinned (see module docs).
pub const UI_SCALE: f32 = VIEW_H as f32 / GB_H as f32;

/// Left edge of the centered, scaled GB frame on screen.
pub const UI_ORIGIN_X: f32 = (VIEW_W as f32 - GB_W as f32 * UI_SCALE) / 2.0;

/// Screen size of one 8x8 GB tile.
pub const UI_TILE_PX: f32 = TILE_PX as f32 * UI_SCALE;

fn quad(page: u16, cx: i32, cy: i32, tile: u16) -> Item {
    Item::UiQuad {
        x: UI_ORIGIN_X + cx as f32 * UI_TILE_PX,
        y: cy as f32 * UI_TILE_PX,
        w: UI_TILE_PX,
        h: UI_TILE_PX,
        page,
        tile,
    }
}

/// Append the UI layer: the retained tile grid (tile 0 = empty), then the
/// last `uiText` run capped by `uiReveal`.
pub fn append_ui(scene: &Scene, pak: &Pak, items: &mut Vec<Item>) {
    let Some(page) = pak.page_of_kind(atlas_kind::UI) else {
        return; // a pak without UI art draws no UI
    };
    for cy in 0..UI_ROWS as i32 {
        for cx in 0..UI_COLS as i32 {
            let tile = scene.ui[cy as usize * UI_COLS + cx as usize];
            if tile != 0 {
                items.push(quad(page, cx, cy, tile));
            }
        }
    }
    let Some(text) = &scene.ui_text else { return };
    let mut pen_x = text.x;
    let mut pen_y = text.y;
    let mut shown = 0u32;
    for ch in text.text.chars() {
        if ch == '\n' {
            pen_x = text.x;
            pen_y += 1;
            continue;
        }
        if shown >= scene.ui_reveal {
            break;
        }
        shown += 1;
        let code = ch as u32;
        let in_grid = (0..UI_COLS as i32).contains(&pen_x) && (0..UI_ROWS as i32).contains(&pen_y);
        if code <= u16::MAX as u32
            && in_grid
            && let Some(tile) = pak.glyph(code as u16)
        {
            items.push(quad(page, pen_x, pen_y, tile));
        }
        pen_x += 1;
    }
}

/// A compact transparent-background 5x7 font. Rows use five bits, MSB on
/// the left. Lowercase is deliberately folded to uppercase: the overlay is
/// a tiny system UI primitive, not the game's cooked GB charmap.
fn glyph(ch: char) -> [u8; 7] {
    let ch = if matches!(ch, 'é' | 'É') {
        'E'
    } else {
        ch.to_ascii_uppercase()
    };
    match ch {
        'A' => [
            0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
        ],
        'B' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110,
        ],
        'C' => [
            0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111,
        ],
        'D' => [
            0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110,
        ],
        'E' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111,
        ],
        'F' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000,
        ],
        'G' => [
            0b01111, 0b10000, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111,
        ],
        'H' => [
            0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
        ],
        'I' => [
            0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111,
        ],
        'J' => [
            0b00111, 0b00010, 0b00010, 0b00010, 0b10010, 0b10010, 0b01100,
        ],
        'K' => [
            0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001,
        ],
        'L' => [
            0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111,
        ],
        'M' => [
            0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001,
        ],
        'N' => [
            0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001,
        ],
        'O' => [
            0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
        ],
        'P' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000,
        ],
        'Q' => [
            0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101,
        ],
        'R' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001,
        ],
        'S' => [
            0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110,
        ],
        'T' => [
            0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100,
        ],
        'U' => [
            0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
        ],
        'V' => [
            0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100,
        ],
        'W' => [
            0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010,
        ],
        'X' => [
            0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001,
        ],
        'Y' => [
            0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100,
        ],
        'Z' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111,
        ],
        '0' => [
            0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
        ],
        '1' => [
            0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ],
        '2' => [
            0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
        ],
        '3' => [
            0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110,
        ],
        '4' => [
            0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
        ],
        '5' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110,
        ],
        '6' => [
            0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
        ],
        '7' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
        ],
        '8' => [
            0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
        ],
        '9' => [
            0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110,
        ],
        ' ' => [0; 7],
        '.' => [0, 0, 0, 0, 0, 0b00110, 0b00110],
        ',' => [0, 0, 0, 0, 0b00110, 0b00110, 0b00100],
        ':' => [0, 0b00110, 0b00110, 0, 0b00110, 0b00110, 0],
        ';' => [0, 0b00110, 0b00110, 0, 0b00110, 0b00110, 0b00100],
        '!' => [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0, 0b00100],
        '?' => [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0, 0b00100],
        '-' => [0, 0, 0, 0b11111, 0, 0, 0],
        '_' => [0, 0, 0, 0, 0, 0, 0b11111],
        '+' => [0, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0],
        '=' => [0, 0b11111, 0, 0b11111, 0, 0, 0],
        '/' => [0b00001, 0b00010, 0b00100, 0b00100, 0b01000, 0b10000, 0],
        '\\' => [0b10000, 0b01000, 0b00100, 0b00100, 0b00010, 0b00001, 0],
        '\'' => [0b00100, 0b00100, 0b00010, 0, 0, 0, 0],
        '"' => [0b01010, 0b01010, 0b00100, 0, 0, 0, 0],
        '(' => [
            0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010,
        ],
        ')' => [
            0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000,
        ],
        '[' => [
            0b01110, 0b01000, 0b01000, 0b01000, 0b01000, 0b01000, 0b01110,
        ],
        ']' => [
            0b01110, 0b00010, 0b00010, 0b00010, 0b00010, 0b00010, 0b01110,
        ],
        '<' => [
            0b00010, 0b00100, 0b01000, 0b10000, 0b01000, 0b00100, 0b00010,
        ],
        '>' => [
            0b01000, 0b00100, 0b00010, 0b00001, 0b00010, 0b00100, 0b01000,
        ],
        '@' => [
            0b01110, 0b10001, 0b10111, 0b10101, 0b10111, 0b10000, 0b01110,
        ],
        '#' => [
            0b01010, 0b11111, 0b01010, 0b01010, 0b11111, 0b01010, 0b01010,
        ],
        '&' => [
            0b01100, 0b10010, 0b10100, 0b01000, 0b10101, 0b10010, 0b01101,
        ],
        '%' => [0b11001, 0b11010, 0b00100, 0b01000, 0b10110, 0b00110, 0],
        '*' => [0, 0b10101, 0b01110, 0b11111, 0b01110, 0b10101, 0],
        '|' => [0b00100; 7],
        '$' => [
            0b00100, 0b01111, 0b10100, 0b01110, 0b00101, 0b11110, 0b00100,
        ],
        '^' => [0b00100, 0b01010, 0b10001, 0, 0, 0, 0],
        _ => [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0, 0b00100],
    }
}

fn push_overlay_rect(
    items: &mut Vec<Item>,
    emitted: &mut usize,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    abgr: u32,
) {
    if *emitted >= UI_OVERLAY_RECTS_MAX {
        return;
    }
    let x0 = x.clamp(0, VIEW_W);
    let y0 = y.clamp(0, VIEW_H);
    let x1 = x.saturating_add(w.max(0)).clamp(0, VIEW_W);
    let y1 = y.saturating_add(h.max(0)).clamp(0, VIEW_H);
    if x1 > x0 && y1 > y0 {
        items.push(Item::OverlayRect {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
            abgr,
        });
        *emitted += 1;
    }
}

/// Append retained overlay commands after the complete GB layer. Labels are
/// expanded into row runs (not one quad per pixel), then every backend can
/// consume one ordered, texture-free rectangle stream.
pub fn append_overlay(scene: &Scene, items: &mut Vec<Item>) {
    let mut emitted = 0usize;
    for command in &scene.ui_overlay {
        if emitted >= UI_OVERLAY_RECTS_MAX {
            break;
        }
        match command {
            UiOverlayItem::Rect(rect) => push_overlay_rect(
                items,
                &mut emitted,
                rect.x,
                rect.y,
                rect.w,
                rect.h,
                rect.abgr,
            ),
            UiOverlayItem::Label(label) => {
                let mut pen_x = label.x;
                let mut pen_y = label.y;
                for ch in label.text.chars() {
                    if emitted >= UI_OVERLAY_RECTS_MAX {
                        break;
                    }
                    if ch == '\n' {
                        pen_x = label.x;
                        pen_y = pen_y.saturating_add(8 * label.scale);
                        continue;
                    }
                    if ch == '\r' {
                        continue;
                    }
                    if ch == '\t' {
                        pen_x = pen_x.saturating_add(24 * label.scale);
                        continue;
                    }
                    for (row, bits) in glyph(ch).into_iter().enumerate() {
                        let mut col = 0i32;
                        while col < 5 {
                            if bits & (1 << (4 - col)) == 0 {
                                col += 1;
                                continue;
                            }
                            let start = col;
                            while col < 5 && bits & (1 << (4 - col)) != 0 {
                                col += 1;
                            }
                            push_overlay_rect(
                                items,
                                &mut emitted,
                                pen_x.saturating_add(start * label.scale),
                                pen_y.saturating_add(row as i32 * label.scale),
                                (col - start) * label.scale,
                                label.scale,
                                label.abgr,
                            );
                            if emitted >= UI_OVERLAY_RECTS_MAX {
                                break;
                            }
                        }
                    }
                    pen_x = pen_x.saturating_add(6 * label.scale);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pak;
    use crate::spec::op;

    #[test]
    fn scale_is_the_pinned_letterbox() {
        assert!((UI_SCALE - 272.0 / 144.0).abs() < 1e-6);
        assert!((UI_ORIGIN_X - (480.0 - 160.0 * UI_SCALE) / 2.0).abs() < 1e-6);
        // The scaled frame fits the screen exactly in height.
        assert!((UI_TILE_PX * UI_ROWS as f32 - VIEW_H as f32).abs() < 1e-3);
    }

    #[test]
    fn grid_text_and_reveal_emit_quads() {
        let blob = pak::AlignedBlob::from_bytes(&pak::tests::tiny_pak_bytes());
        let pak = pak::read(blob.bytes()).unwrap();
        let mut s = Scene::new();
        let count = |s: &Scene| {
            let mut items = Vec::new();
            append_ui(s, &pak, &mut items);
            items.len()
        };
        assert_eq!(count(&s), 0);
        s.op(op::UI_TILE, &[0, 0, 9], None);
        assert_eq!(count(&s), 1);
        // "AB A" has glyphs for A and B; the space misses the CMAP but
        // still advances and counts toward the reveal.
        s.op(op::UI_TEXT, &[1, 1], Some("AB A"));
        assert_eq!(count(&s), 1 + 3);
        s.op(op::UI_REVEAL, &[0], None);
        assert_eq!(count(&s), 1);
        s.op(op::UI_REVEAL, &[3], None);
        assert_eq!(count(&s), 1 + 2, "reveal 3 = A, B, space");
        s.op(op::UI_REVEAL, &[4], None);
        assert_eq!(count(&s), 1 + 3);
        s.op(op::UI_CLEAR, &[], None);
        assert_eq!(count(&s), 0);
    }

    #[test]
    fn overlay_labels_expand_to_ordered_clipped_runs() {
        let mut s = Scene::new();
        s.op(op::UI_RECT, &[-4, 3, 8, 9, 0x4433_2211], None);
        s.op(op::UI_LABEL, &[4, 5, 2, -1], Some("a-?"));
        let mut items = Vec::new();
        append_overlay(&s, &mut items);
        assert_eq!(
            items[0],
            Item::OverlayRect {
                x: 0,
                y: 3,
                w: 4,
                h: 9,
                abgr: 0x4433_2211,
            }
        );
        assert!(items[1..].iter().all(|item| matches!(
            item,
            Item::OverlayRect {
                abgr: 0xffff_ffff,
                ..
            }
        )));
        assert_eq!(glyph('a'), glyph('A'));
        assert_eq!(glyph('é'), glyph('E'));
        assert_ne!(glyph('-'), [0; 7]);
    }
}
