//! The GB UI tile layer → screen-space [`Item::UiQuad`]s.
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
use crate::scene::Scene;
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
}
