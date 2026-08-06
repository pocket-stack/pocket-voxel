//! The retained scene the guest drives through `voxel` surface ops
//! (contracts/spec/voxel-spec.ts §Ops). Presentation state only — zero
//! gameplay: map slots, camera, pitch tween, tint, stamp toggles, entity
//! billboards, the GB UI tile layer, and the battle stage.
//!
//! Dispatch is defensive by contract: an unknown op code, a malformed arg
//! list, or an out-of-range slot is a **no-op, never a panic** — the op
//! stream crosses a trust boundary (the QuickJS guest) and the core must
//! survive anything it says.

use alloc::string::String;
use alloc::vec::Vec;

use crate::audio::Audio;
use crate::pak::Pak;
use crate::spec::{
    self, ENTS_MAX, PITCH_RUNGS, PITCH_TWEEN_TICKS, Q8, QUALITY, QUALITY_TIER_DEFAULT,
    QualityDials, RIG_ZOOM_MAX, RIG_ZOOM_MIN, UI_COLS, UI_ROWS, op,
};

/// Map slots: slot 0 is the current map, 1..4 the connected neighbours at
/// their seam offsets (voxel-spec.ts `mapShow`).
pub const MAP_SLOTS: usize = 5;

/// Packed [`OpResult::Stats`] layout: `u32 tick | u32 ops_applied`.
/// Debug-only counters, not part of the contract.
pub const STATS_LEN: usize = 8;

/// What an op call hands back to the host.
#[derive(Clone, Debug, PartialEq)]
pub enum OpResult {
    /// Nothing to return (the overwhelmingly common case).
    None,
    /// `gamedata()`: the host must answer with the pak's GAME section — the
    /// scene deliberately does not hold the pak, so it signals instead of
    /// carrying the bytes.
    Gamedata,
    /// `stats()`: packed frame counters ([`STATS_LEN`]).
    Stats([u8; STATS_LEN]),
}

#[derive(Clone, Copy, Debug, Default)]
pub struct MapSlot {
    pub shown: bool,
    pub map_id: u32,
    /// Seam offset in world px (applied to x / z).
    pub ox: i32,
    pub oy: i32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Ent {
    pub shown: bool,
    /// Atlas page index of the walk sheet (16x16 frames stacked vertically).
    pub sheet: i32,
    pub frame: i32,
    /// World px, Q4 fixed (value = px * 16).
    pub x: i32,
    pub y: i32,
    /// World px above ground (the card's feet height).
    pub lift: i32,
    pub flags: u32,
    /// `spec::emote` kind; 0 = none.
    pub emote: u8,
}

#[derive(Clone, Debug)]
pub struct UiText {
    /// Grid cell of the first glyph.
    pub x: i32,
    pub y: i32,
    pub text: String,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct BattleCard {
    pub shown: bool,
    /// Atlas page index of the pic (one page per battle sprite).
    pub pic: i32,
    /// Cell coords on the current map.
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug)]
pub struct Battle {
    pub active: bool,
    pub map_id: u32,
    /// Arena anchor cell.
    pub x: i32,
    pub y: i32,
    /// `spec::arena_shape`.
    pub shape: u8,
    /// 0 = tele, 1 = wide.
    pub rig: u8,
    /// Player (0) / enemy (1).
    pub cards: [BattleCard; 2],
    /// Q8 turn fraction (wraps).
    pub orbit: i32,
    /// Q8 fraction of RIG_PITCH_MAX_DEG (clamped at use).
    pub pitch: i32,
    /// Q8 zoom multiplier (clamped to RIG_ZOOM_MIN..MAX at use).
    pub zoom: i32,
}

impl Default for Battle {
    fn default() -> Self {
        Self {
            active: false,
            map_id: 0,
            x: 0,
            y: 0,
            shape: 0,
            rig: 0,
            cards: [BattleCard::default(); 2],
            orbit: 0,
            pitch: 0,
            zoom: Q8, // 1.0x
        }
    }
}

pub struct Scene {
    pub maps: [MapSlot; MAP_SLOTS],
    /// Camera view centre in world px, Q4 fixed.
    pub cam_x: i32,
    pub cam_y: i32,
    /// Current pitch rung (PITCH_RUNGS index) the tween heads toward.
    pub pitch_rung: usize,
    /// Pitch in degrees the running tween left from.
    pub pitch_from_deg: f32,
    /// Ticks since the tween started (saturates; >= PITCH_TWEEN_TICKS = settled).
    pub pitch_t: u32,
    /// Global day tint, ABGR (0xffffffff = neutral).
    pub tint: u32,
    /// Selected SGB palette: index into the pak's SGB set (VPAL[4 + i]) for
    /// the non-ui atlas kinds; -1 = the GB grayscale ramp (voxel-spec.ts
    /// `palette`).
    pub palette: i32,
    /// Stamps toggled OFF: (map_id, cx, cy). Stamps default to shown.
    pub stamps_off: Vec<(u32, i16, i16)>,
    pub ents: [Ent; ENTS_MAX],
    /// The GB UI tile grid, row-major. Tile 0 = empty (not drawn).
    pub ui: [u16; UI_COLS * UI_ROWS],
    /// The last `uiText` run; drawn over the grid, capped by `ui_reveal`.
    pub ui_text: Option<UiText>,
    /// Glyphs of `ui_text` shown. `uiText` resets it to "all".
    pub ui_reveal: u32,
    pub battle: Battle,
    /// The quality rung this host climbed to (`spec::quality_tier`), always a
    /// valid index into [`spec::QUALITY`]. HOST configuration, not guest
    /// state: the host knows the machine, so `reset()` keeps this exactly as
    /// it keeps the synth's rate (voxel-spec.ts `quality`).
    pub quality: u8,
    /// The chip synth. Presentation like everything else here: the guest says
    /// what to play in numbers, the core interprets the ROM's channel
    /// programs, and the host pumps [`Scene::render_audio`] for the frames
    /// its ring wants. A host that mounts no audio module never pumps, and
    /// the identical op stream runs silent.
    pub audio: Audio,
    /// The tick index — the only clock (tile animation, cursors, rig drift).
    pub tick: u32,
    /// Total ops dispatched (debug counter for `stats()`).
    pub ops: u32,
}

impl Scene {
    pub fn new() -> Self {
        Self {
            maps: [MapSlot::default(); MAP_SLOTS],
            cam_x: 0,
            cam_y: 0,
            pitch_rung: 0,
            pitch_from_deg: PITCH_RUNGS[0],
            pitch_t: PITCH_TWEEN_TICKS, // settled at rung 0
            tint: 0xffff_ffff,
            palette: -1,
            stamps_off: Vec::new(),
            ents: [Ent::default(); ENTS_MAX],
            ui: [0u16; UI_COLS * UI_ROWS],
            ui_text: None,
            ui_reveal: u32::MAX,
            battle: Battle::default(),
            quality: QUALITY_TIER_DEFAULT,
            audio: Audio::new(),
            tick: 0,
            ops: 0,
        }
    }

    /// The dials of the rung this scene is on — the ONE place the ladder is
    /// read. `quality` is range-checked on the way in, so this cannot fail;
    /// the fallback keeps an impossible value rendering the default rung
    /// rather than panicking on untrusted state.
    pub fn dials(&self) -> &'static QualityDials {
        QUALITY
            .get(self.quality as usize)
            .unwrap_or(&QUALITY[QUALITY_TIER_DEFAULT as usize])
    }

    /// Advance the tick clock. The host calls this exactly once per frame,
    /// after the tick's ops.
    pub fn tick(&mut self) {
        self.tick = self.tick.wrapping_add(1);
        self.pitch_t = self.pitch_t.saturating_add(1);
        self.audio.tick();
    }

    /// Render `frames` interleaved stereo frames of the chip synth into `out`
    /// (which must hold `frames * 2` samples; a short buffer renders what
    /// fits). The host calls this once per tick with exactly the frames its
    /// ring wants — `audioFramesForTick` on a virtual clock, whatever the
    /// device's credit says on a real one.
    ///
    /// Pure in (the ops applied so far, the frames asked for): no clock is
    /// read, so splitting one tick's frames across two calls writes the same
    /// bytes as asking for them at once.
    pub fn render_audio(&mut self, pak: &Pak<'_>, frames: usize, out: &mut [i16]) {
        let want = frames.min(out.len() / 2) * 2;
        self.audio.render(pak.audio_programs(), &mut out[..want]);
    }

    /// The tweened camera pitch in degrees (smoothstep between the tween's
    /// start pitch and the target rung over PITCH_TWEEN_TICKS).
    pub fn pitch_deg(&self) -> f32 {
        let target = PITCH_RUNGS[self.pitch_rung];
        let t = (self.pitch_t as f32 / PITCH_TWEEN_TICKS as f32).min(1.0);
        let s = t * t * (3.0 - 2.0 * t);
        self.pitch_from_deg + (target - self.pitch_from_deg) * s
    }

    /// Camera view centre in world px (Q4 -> f32).
    pub fn cam_px(&self) -> (f32, f32) {
        (
            self.cam_x as f32 / spec::Q4 as f32,
            self.cam_y as f32 / spec::Q4 as f32,
        )
    }

    /// True when the stamp at (map_id, cx, cy) is currently shown.
    pub fn stamp_shown(&self, map_id: u32, cx: i16, cy: i16) -> bool {
        !self
            .stamps_off
            .iter()
            .any(|&(m, x, y)| m == map_id && x == cx && y == cy)
    }

    /// The battle zoom as a clamped multiplier.
    pub fn battle_zoom(&self) -> f32 {
        (self.battle.zoom as f32 / Q8 as f32).clamp(RIG_ZOOM_MIN, RIG_ZOOM_MAX)
    }

    /// Dispatch one op (voxel-spec.ts §Ops). `args` are the numeric args in
    /// order; `s` carries the string for the string-bearing ops (`uiText`).
    /// Unknown codes and malformed calls are no-ops.
    pub fn op(&mut self, code: u32, args: &[i32], s: Option<&str>) -> OpResult {
        self.ops = self.ops.wrapping_add(1);
        let a = |i: usize| args.get(i).copied().unwrap_or(0);
        // The audio group owns its own codes (voxel-spec.ts §audio).
        if self.audio.op(code, args) {
            return OpResult::None;
        }
        match code {
            op::GAMEDATA => return OpResult::Gamedata,
            op::STATS => {
                let mut out = [0u8; STATS_LEN];
                out[0..4].copy_from_slice(&self.tick.to_le_bytes());
                out[4..8].copy_from_slice(&self.ops.to_le_bytes());
                return OpResult::Stats(out);
            }
            op::RESET => {
                // The synth's pinned engine tables and output rate are boot
                // configuration, not scene state; carry them across. So is
                // the quality rung: the machine did not change.
                let audio = core::mem::take(&mut self.audio).into_reset();
                let quality = self.quality;
                *self = Scene::new();
                self.audio = audio;
                self.quality = quality;
            }
            op::QUALITY => {
                // Out of range is a no-op, never a clamp: a host naming a rung
                // this core does not carry keeps the rung it had rather than
                // silently landing on a neighbour's dials.
                let tier = a(0);
                if !args.is_empty() && (0..QUALITY.len() as i32).contains(&tier) {
                    self.quality = tier as u8;
                }
            }

            op::MAP_SHOW => {
                if args.len() >= 4
                    && let Some(slot) = self.maps.get_mut(a(0) as usize)
                {
                    *slot = MapSlot {
                        shown: true,
                        map_id: a(1) as u32,
                        ox: a(2),
                        oy: a(3),
                    };
                }
            }
            op::MAP_HIDE => {
                if let Some(slot) = self.maps.get_mut(a(0) as usize) {
                    slot.shown = false;
                }
            }
            op::CAM => {
                if args.len() >= 2 {
                    self.cam_x = a(0);
                    self.cam_y = a(1);
                }
            }
            op::PITCH => {
                let rung = a(0);
                if (0..PITCH_RUNGS.len() as i32).contains(&rung) {
                    // Restart the tween from wherever the camera is now, so
                    // a mid-tween rung change never snaps.
                    self.pitch_from_deg = self.pitch_deg();
                    self.pitch_rung = rung as usize;
                    self.pitch_t = 0;
                }
            }
            op::TINT => self.tint = a(0) as u32,
            op::PALETTE => {
                if !args.is_empty() {
                    self.palette = a(0);
                }
            }
            op::STAMP => {
                if args.len() >= 4 {
                    let key = (a(0) as u32, a(1) as i16, a(2) as i16);
                    self.stamps_off.retain(|&k| k != key);
                    if a(3) == 0 {
                        self.stamps_off.push(key);
                    }
                }
            }

            op::ENT => {
                if args.len() >= 7
                    && let Some(ent) = self.ents.get_mut(a(0) as usize)
                {
                    let emote = ent.emote; // pose updates keep the bubble
                    *ent = Ent {
                        shown: true,
                        sheet: a(1),
                        frame: a(2),
                        x: a(3),
                        y: a(4),
                        lift: a(5),
                        flags: a(6) as u32,
                        emote,
                    };
                }
            }
            op::ENT_HIDE => {
                if let Some(ent) = self.ents.get_mut(a(0) as usize) {
                    ent.shown = false;
                    ent.emote = spec::emote::NONE;
                }
            }
            op::EMOTE => {
                if args.len() >= 2
                    && let Some(ent) = self.ents.get_mut(a(0) as usize)
                {
                    ent.emote = a(1) as u8;
                }
            }

            op::UI_TILE => {
                if args.len() >= 3 {
                    let (x, y) = (a(0), a(1));
                    if (0..UI_COLS as i32).contains(&x) && (0..UI_ROWS as i32).contains(&y) {
                        self.ui[y as usize * UI_COLS + x as usize] = a(2) as u16;
                    }
                }
            }
            op::UI_FILL => {
                if args.len() >= 5 {
                    let x0 = a(0).clamp(0, UI_COLS as i32);
                    let y0 = a(1).clamp(0, UI_ROWS as i32);
                    let x1 = a(0).saturating_add(a(2).max(0)).clamp(0, UI_COLS as i32);
                    let y1 = a(1).saturating_add(a(3).max(0)).clamp(0, UI_ROWS as i32);
                    for y in y0..y1 {
                        for x in x0..x1 {
                            self.ui[y as usize * UI_COLS + x as usize] = a(4) as u16;
                        }
                    }
                }
            }
            op::UI_TEXT => {
                if args.len() >= 2
                    && let Some(text) = s
                {
                    self.ui_text = Some(UiText {
                        x: a(0),
                        y: a(1),
                        text: String::from(text),
                    });
                    // New text shows fully until the guest starts a reveal.
                    self.ui_reveal = u32::MAX;
                }
            }
            op::UI_REVEAL => self.ui_reveal = a(0).max(0) as u32,
            op::UI_CLEAR => {
                self.ui = [0u16; UI_COLS * UI_ROWS];
                self.ui_text = None;
                self.ui_reveal = u32::MAX;
            }

            op::ARENA => {
                if args.len() >= 5 {
                    // Entering the arena resets the staging camera; cards
                    // arrive through their own ops.
                    self.battle = Battle {
                        active: true,
                        map_id: a(0) as u32,
                        x: a(1),
                        y: a(2),
                        shape: a(3) as u8,
                        rig: a(4) as u8,
                        ..Battle::default()
                    };
                }
            }
            op::CARD => {
                if args.len() >= 4
                    && let Some(card) = self.battle.cards.get_mut(a(0) as usize)
                {
                    *card = BattleCard {
                        shown: true,
                        pic: a(1),
                        x: a(2),
                        y: a(3),
                    };
                }
            }
            op::CARD_HIDE => {
                if let Some(card) = self.battle.cards.get_mut(a(0) as usize) {
                    card.shown = false;
                }
            }
            op::BATTLE_CAM => {
                if args.len() >= 3 {
                    self.battle.orbit = a(0);
                    self.battle.pitch = a(1);
                    self.battle.zoom = a(2);
                }
            }
            op::ARENA_END => self.battle = Battle::default(),

            _ => {} // unknown op: no-op by contract (append-only op space)
        }
        OpResult::None
    }
}

impl Default for Scene {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_dispatch_mutates_state() {
        let mut s = Scene::new();
        s.op(op::MAP_SHOW, &[0, 7, 0, 0], None);
        s.op(op::MAP_SHOW, &[1, 8, -128, 0], None);
        assert!(s.maps[0].shown && s.maps[1].shown);
        assert_eq!(s.maps[1].ox, -128);
        s.op(op::MAP_HIDE, &[1], None);
        assert!(!s.maps[1].shown);

        s.op(op::ENT, &[0, 2, 1, 160, 320, 0, 3], None);
        assert!(s.ents[0].shown);
        assert_eq!(s.ents[0].flags, 3);
        s.op(op::EMOTE, &[0, 2], None);
        assert_eq!(s.ents[0].emote, 2);
        s.op(op::ENT, &[0, 2, 2, 176, 320, 0, 3], None);
        assert_eq!(s.ents[0].emote, 2, "pose update keeps the emote");
        s.op(op::ENT_HIDE, &[0], None);
        assert!(!s.ents[0].shown);

        s.op(op::TINT, &[0x40ff8040u32 as i32], None);
        assert_eq!(s.tint, 0x40ff8040);

        assert_eq!(s.palette, -1, "boot palette is the GB grayscale ramp");
        s.op(op::PALETTE, &[3], None);
        assert_eq!(s.palette, 3);
        s.op(op::PALETTE, &[-1], None);
        assert_eq!(s.palette, -1);
        s.op(op::PALETTE, &[5], None);
        s.op(op::PALETTE, &[], None);
        assert_eq!(s.palette, 5, "malformed palette op is a no-op");

        s.op(op::STAMP, &[7, 3, 4, 0], None);
        assert!(!s.stamp_shown(7, 3, 4));
        assert!(s.stamp_shown(7, 3, 5));
        s.op(op::STAMP, &[7, 3, 4, 1], None);
        assert!(s.stamp_shown(7, 3, 4));

        s.op(op::ARENA, &[7, 10, 12, 0, 1], None);
        assert!(s.battle.active);
        assert_eq!(s.battle.rig, 1);
        s.op(op::CARD, &[1, 5, 11, 13], None);
        assert!(s.battle.cards[1].shown);
        s.op(op::ARENA_END, &[], None);
        assert!(!s.battle.active);
    }

    /// The `quality` op is HOST configuration: it survives `reset`, refuses
    /// a rung this core does not carry, and boots at the weakest rung.
    #[test]
    fn quality_is_host_configuration() {
        let mut s = Scene::new();
        assert_eq!(s.quality, spec::quality_tier::PSP, "boots at the weakest");
        assert_eq!(s.dials(), &spec::QUALITY[spec::quality_tier::PSP as usize]);

        s.op(op::QUALITY, &[spec::quality_tier::DESKTOP as i32], None);
        assert_eq!(s.quality, spec::quality_tier::DESKTOP);
        assert_eq!(
            s.dials(),
            &spec::QUALITY[spec::quality_tier::DESKTOP as usize]
        );

        // Out of range and malformed are no-ops, not clamps: a host naming a
        // rung this core is older than keeps the rung it had.
        s.op(op::QUALITY, &[spec::QUALITY.len() as i32], None);
        s.op(op::QUALITY, &[-1], None);
        s.op(op::QUALITY, &[], None);
        assert_eq!(s.quality, spec::quality_tier::DESKTOP);

        // The machine did not change, so neither does the rung.
        s.op(op::CAM, &[99, 99], None);
        s.op(op::RESET, &[], None);
        assert_eq!(s.cam_x, 0, "reset still drops scene state");
        assert_eq!(
            s.quality,
            spec::quality_tier::DESKTOP,
            "reset keeps the rung, like the synth's rate"
        );
    }

    #[test]
    fn unknown_and_malformed_ops_are_noops() {
        let mut s = Scene::new();
        let before_tint = s.tint;
        assert_eq!(s.op(9999, &[1, 2, 3], None), OpResult::None);
        assert_eq!(s.op(0, &[], None), OpResult::None);
        // Malformed: too few args, out-of-range slots.
        s.op(op::MAP_SHOW, &[0, 7], None);
        assert!(!s.maps[0].shown);
        s.op(op::ENT, &[99, 0, 0, 0, 0, 0, 0], None);
        s.op(op::UI_TILE, &[25, 3, 1], None);
        s.op(op::UI_TILE, &[3, -1, 1], None);
        assert!(s.ui.iter().all(|&t| t == 0));
        s.op(op::PITCH, &[99], None);
        assert_eq!(s.pitch_rung, 0);
        assert_eq!(s.tint, before_tint);
    }

    #[test]
    fn ui_text_and_reveal() {
        let mut s = Scene::new();
        s.op(op::UI_TEXT, &[1, 14], Some("HELLO"));
        assert_eq!(s.ui_text.as_ref().unwrap().text, "HELLO");
        assert_eq!(s.ui_reveal, u32::MAX, "fresh text shows fully");
        s.op(op::UI_REVEAL, &[0], None);
        assert_eq!(s.ui_reveal, 0);
        s.op(op::UI_REVEAL, &[3], None);
        assert_eq!(s.ui_reveal, 3);
        s.op(op::UI_TEXT, &[1, 16], Some("WORLD"));
        assert_eq!(s.ui_reveal, u32::MAX, "new text resets the cap");
        s.op(op::UI_CLEAR, &[], None);
        assert!(s.ui_text.is_none());

        s.op(op::UI_FILL, &[18, 16, 5, 5, 7], None);
        assert_eq!(s.ui[17 * UI_COLS + 19], 7, "fill clips to the grid");
        assert_eq!(s.ui[16 * UI_COLS + 17], 0);
    }

    #[test]
    fn q4_cam_and_pitch_tween() {
        let mut s = Scene::new();
        s.op(op::CAM, &[featured_px(120), featured_px(68)], None);
        assert_eq!(s.cam_px(), (120.0, 68.0));
        // Q4 gives sub-pixel scroll.
        s.op(op::CAM, &[featured_px(120) + 8, featured_px(68)], None);
        assert_eq!(s.cam_px().0, 120.5);

        assert_eq!(s.pitch_deg(), 0.0);
        s.op(op::PITCH, &[4], None);
        assert_eq!(s.pitch_deg(), 0.0, "tween starts at the old pitch");
        for _ in 0..PITCH_TWEEN_TICKS {
            s.tick();
        }
        assert_eq!(s.pitch_deg(), PITCH_RUNGS[4]);
        // Halfway is smoothstepped, not linear.
        s.op(op::PITCH, &[0], None);
        for _ in 0..7 {
            s.tick();
        }
        let mid = s.pitch_deg();
        assert!(mid < PITCH_RUNGS[4] && mid > 0.0);

        s.op(op::STATS, &[], None);
        let OpResult::Stats(stats) = s.op(op::STATS, &[], None) else {
            panic!("stats returns bytes");
        };
        assert_eq!(u32::from_le_bytes(stats[0..4].try_into().unwrap()), s.tick);
        assert_eq!(s.op(op::GAMEDATA, &[], None), OpResult::Gamedata);

        s.op(op::PALETTE, &[7], None);
        s.op(op::RESET, &[], None);
        assert_eq!(s.cam_x, 0);
        assert_eq!(s.tick, 0);
        assert_eq!(s.palette, -1, "reset restores the grayscale ramp");
    }

    fn featured_px(px: i32) -> i32 {
        px * spec::Q4
    }
}
