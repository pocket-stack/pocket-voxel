//! Cardputer Zero display fitting and keyboard mapping.
//!
//! The device host keeps Pocket Voxel's 480x272 logical frame intact. The
//! 320x170 panel receives a 300x170 image with ten black pixels on each side:
//! the exact 30:17 game aspect fits the panel height without stretching.

use std::collections::BTreeSet;

/// A centered, aspect-preserving fit from a logical frame into a panel.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScalePlan {
    pub src_w: usize,
    pub src_h: usize,
    pub dst_w: usize,
    pub dst_h: usize,
    pub draw_w: usize,
    pub draw_h: usize,
    pub offset_x: usize,
    pub offset_y: usize,
}

impl ScalePlan {
    pub fn fit(src_w: usize, src_h: usize, dst_w: usize, dst_h: usize) -> Option<Self> {
        if src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
            return None;
        }
        let (draw_w, draw_h) = if dst_w.saturating_mul(src_h) <= dst_h.saturating_mul(src_w) {
            (dst_w, src_h.saturating_mul(dst_w) / src_w)
        } else {
            (src_w.saturating_mul(dst_h) / src_h, dst_h)
        };
        Some(Self {
            src_w,
            src_h,
            dst_w,
            dst_h,
            draw_w: draw_w.max(1),
            draw_h: draw_h.max(1),
            offset_x: (dst_w - draw_w.max(1)) / 2,
            offset_y: (dst_h - draw_h.max(1)) / 2,
        })
    }

    /// Scale ABGR8888 words into a little-endian RGB565 framebuffer.
    ///
    /// Bilinear sampling is used because 480->300 is a fractional reduction;
    /// nearest-neighbour drops alternating columns from small UI glyphs.
    pub fn write_rgb565(&self, src: &[u32], dst: &mut [u8], stride: usize) -> bool {
        if src.len() != self.src_w.saturating_mul(self.src_h)
            || stride < self.dst_w.saturating_mul(2)
            || dst.len() < stride.saturating_mul(self.dst_h)
        {
            return false;
        }
        dst.fill(0);
        for dy in 0..self.draw_h {
            let (y0, y1, fy) = sample_axis(dy, self.draw_h, self.src_h);
            let row = (self.offset_y + dy) * stride;
            for dx in 0..self.draw_w {
                let (x0, x1, fx) = sample_axis(dx, self.draw_w, self.src_w);
                let c00 = src[y0 * self.src_w + x0];
                let c10 = src[y0 * self.src_w + x1];
                let c01 = src[y1 * self.src_w + x0];
                let c11 = src[y1 * self.src_w + x1];
                let r = bilerp(c00 & 0xff, c10 & 0xff, c01 & 0xff, c11 & 0xff, fx, fy);
                let g = bilerp(
                    (c00 >> 8) & 0xff,
                    (c10 >> 8) & 0xff,
                    (c01 >> 8) & 0xff,
                    (c11 >> 8) & 0xff,
                    fx,
                    fy,
                );
                let b = bilerp(
                    (c00 >> 16) & 0xff,
                    (c10 >> 16) & 0xff,
                    (c01 >> 16) & 0xff,
                    (c11 >> 16) & 0xff,
                    fx,
                    fy,
                );
                let rgb565 = (((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)) as u16;
                let at = row + (self.offset_x + dx) * 2;
                dst[at..at + 2].copy_from_slice(&rgb565.to_le_bytes());
            }
        }
        true
    }
}

/// Source pixel pair and 8-bit fraction for destination-pixel-centre mapping.
fn sample_axis(dst: usize, dst_len: usize, src_len: usize) -> (usize, usize, u32) {
    let centre = ((dst * 2 + 1) * src_len * 256) / (dst_len * 2);
    let pos = centre.saturating_sub(128);
    let a = (pos / 256).min(src_len - 1);
    let b = (a + 1).min(src_len - 1);
    (a, b, (pos & 0xff) as u32)
}

fn bilerp(c00: u32, c10: u32, c01: u32, c11: u32, fx: u32, fy: u32) -> u32 {
    let top = c00 * (256 - fx) + c10 * fx;
    let bottom = c01 * (256 - fx) + c11 * fx;
    (top * (256 - fy) + bottom * fy + 32768) >> 16
}

// Linux input-event key codes used by the TCA8418 keyboard.
const KEY_ESC: u16 = 1;
const KEY_BACKSPACE: u16 = 14;
const KEY_Q: u16 = 16;
const KEY_W: u16 = 17;
const KEY_O: u16 = 24;
const KEY_P: u16 = 25;
const KEY_ENTER: u16 = 28;
const KEY_A: u16 = 30;
const KEY_S: u16 = 31;
const KEY_D: u16 = 32;
const KEY_J: u16 = 36;
const KEY_K: u16 = 37;
const KEY_Z: u16 = 44;
const KEY_X: u16 = 45;
const KEY_SPACE: u16 = 57;
const KEY_UP: u16 = 103;
const KEY_LEFT: u16 = 105;
const KEY_RIGHT: u16 = 106;
const KEY_DOWN: u16 = 108;

/// Held-key state. Several physical keys may own one abstract button.
#[derive(Default)]
pub struct KeyboardState {
    held: BTreeSet<u16>,
    quit: bool,
}

impl KeyboardState {
    /// Apply one EV_KEY event (`value`: 0 up, 1 down, 2 repeat).
    pub fn event(&mut self, code: u16, value: i32) {
        if code == KEY_ESC && value == 1 {
            self.quit = true;
        }
        if button_for_key(code).is_none() {
            return;
        }
        if value == 0 {
            self.held.remove(&code);
        } else if value == 1 || value == 2 {
            self.held.insert(code);
        }
    }

    pub fn mask(&self) -> u32 {
        self.held
            .iter()
            .filter_map(|code| button_for_key(*code))
            .fold(0, |mask, bit| mask | bit)
    }

    pub fn quit_requested(&self) -> bool {
        self.quit
    }
}

fn button_for_key(code: u16) -> Option<u32> {
    use pocketvoxel_core::spec::btn;
    match code {
        KEY_UP | KEY_W => Some(btn::UP),
        KEY_DOWN | KEY_S => Some(btn::DOWN),
        KEY_LEFT | KEY_A => Some(btn::LEFT),
        KEY_RIGHT | KEY_D => Some(btn::RIGHT),
        KEY_ENTER | KEY_SPACE | KEY_Z | KEY_J => Some(btn::A),
        KEY_BACKSPACE | KEY_X | KEY_K => Some(btn::B),
        KEY_P => Some(btn::START),
        KEY_O | KEY_Q => Some(btn::SELECT),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocketvoxel_core::spec::btn;

    #[test]
    fn cardputer_panel_fit_is_exact_and_centered() {
        let plan = ScalePlan::fit(480, 272, 320, 170).unwrap();
        assert_eq!((plan.draw_w, plan.draw_h), (300, 170));
        assert_eq!((plan.offset_x, plan.offset_y), (10, 0));
    }

    #[test]
    fn rgb565_output_keeps_black_letterbox_bars() {
        let plan = ScalePlan::fit(4, 2, 6, 2).unwrap();
        let src = vec![0xff00_00ff; 8]; // opaque red in ABGR
        let mut dst = vec![0xaa; 6 * 2 * 2];
        assert!(plan.write_rgb565(&src, &mut dst, 12));
        assert_eq!(&dst[0..2], &[0, 0]);
        assert_eq!(&dst[2..4], &0xf800u16.to_le_bytes());
        assert_eq!(&dst[10..12], &[0, 0]);
    }

    #[test]
    fn keyboard_supports_overlapping_bindings_and_exit() {
        let mut keys = KeyboardState::default();
        keys.event(KEY_UP, 1);
        keys.event(KEY_W, 1);
        keys.event(KEY_ENTER, 1);
        assert_eq!(keys.mask(), btn::UP | btn::A);
        keys.event(KEY_UP, 0);
        assert_eq!(keys.mask(), btn::UP | btn::A);
        keys.event(KEY_W, 0);
        assert_eq!(keys.mask(), btn::A);
        keys.event(KEY_ESC, 1);
        assert!(keys.quit_requested());
    }
}
