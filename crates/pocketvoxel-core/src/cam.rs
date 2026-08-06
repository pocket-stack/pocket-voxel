//! The diorama cameras, ported from the upstream mod (docs/VOXEL.md §6):
//! the orbit pitch ladder for free roam and the two solved over-the-shoulder
//! rigs for battle staging. All constants come from `spec`.
//!
//! World conventions (voxel-spec.ts WORLD_AXES): world px, +X east, +Y up,
//! +Z south, right-handed. The orbit camera sits south of its focus and
//! looks north as pitch rises; at rung 0 it is straight overhead and frames
//! exactly like the flat 2D game.

use crate::math::{Frustum, Mat4, Vec3, atan2f, atanf, cosf, sinf, sqrtf, vec3};
use crate::spec::{
    ARENA_GAP_CELLS, CAM_FOCAL, CELL_PX, RIG_DOLLY, RIG_DOLLY_TICKS, RIG_PAN_TICKS,
    RIG_PAN_YAW_DEG, RIG_PITCH_MAX_DEG, RIG_ZOOM_MAX, RIG_ZOOM_MIN, VIEW_H, VIEW_W, WORLD_VIEW_H,
    rig_tele, rig_wide,
};

const PI: f32 = core::f32::consts::PI;
const TAU: f32 = core::f32::consts::TAU;

/// A solved camera: everything a backend needs to draw one frame.
#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub eye: Vec3,
    pub focus: Vec3,
    pub up: Vec3,
    /// View direction's angle from straight down, radians — the billboard
    /// lean angle and the argument of the camera-ward pull.
    pub a: f32,
    pub fov_y: f32,
    pub aspect: f32,
    pub near: f32,
    pub far: f32,
    /// perspective(fov, aspect, near, far) * lookAt(eye, focus, up).
    pub vp: Mat4,
}

impl Camera {
    pub fn frustum(&self) -> Frustum {
        Frustum::from_clip(&self.vp)
    }
}

fn finish(eye: Vec3, focus: Vec3, up: Vec3, a: f32, fov_y: f32, dist: f32) -> Camera {
    // Near/far bracket the diorama: near hugs the eye (the map is small),
    // far leaves room for neighbour maps behind the horizon.
    let near = (dist * 0.05).max(1.0);
    let far = dist * 4.0 + 4096.0;
    let aspect = VIEW_W as f32 / VIEW_H as f32;
    let vp = Mat4::perspective_gl(fov_y, aspect, near, far).mul(&Mat4::look_at(eye, focus, up));
    Camera {
        eye,
        focus,
        up,
        a,
        fov_y,
        aspect,
        near,
        far,
        vp,
    }
}

/// The free-roam orbit camera at view centre `(cx, cy)` (world px) and
/// `pitch_deg` from straight down (the tweened rung pitch).
///
/// Ported from the upstream mod: dist = CAM_FOCAL * WORLD_VIEW_H and
/// fov = 2*atan(1/(2*CAM_FOCAL)), so a rung-0 (straight-down) camera frames
/// exactly WORLD_VIEW_H world px vertically — framing-identical to the flat
/// 2D game. Screen-up is north (-Z) at every pitch.
pub fn orbit(cx: f32, cy: f32, pitch_deg: f32) -> Camera {
    let a = pitch_deg.to_radians();
    let dist = CAM_FOCAL * WORLD_VIEW_H as f32;
    let fov = 2.0 * atanf(1.0 / (2.0 * CAM_FOCAL));
    let focus = vec3(cx, 0.0, cy);
    let eye = vec3(cx, dist * cosf(a), cy + dist * sinf(a));
    let up = vec3(0.0, sinf(a), -cosf(a));
    finish(eye, focus, up, a, fov, dist)
}

/// The screen row of the horizon at infinity for a frame `h` rows tall,
/// clamped to `[0, h]` (0 = no sky in frame).
///
/// Derivation (docs/VOXEL.md §6): the horizon is the image of the flattened
/// forward direction, so push `d = normalize(focus.xz - eye.xz)` through the
/// VP **as a direction** (w = 0) and perspective-divide. With our column-
/// major [`Mat4`] and GL clip conventions NDC +y is screen-up, so the row
/// from the top is `(1 - (y/w * 0.5 + 0.5)) * h`. A straight-down camera has
/// no flattened forward (and no horizon): row 0.
pub fn horizon_row(cam: &Camera, h: i32) -> i32 {
    let dx = cam.focus.x - cam.eye.x;
    let dz = cam.focus.z - cam.eye.z;
    let len = sqrtf(dx * dx + dz * dz);
    if len < 1e-4 {
        return 0; // straight down: all diorama, no sky
    }
    let clip = cam.vp.transform(vec3(dx / len, 0.0, dz / len), 0.0);
    if clip.w <= 1e-6 {
        return 0; // horizon behind the camera
    }
    let ndc_y = clip.y / clip.w;
    let row = (1.0 - (ndc_y * 0.5 + 0.5)) * h as f32;
    (row as i32).clamp(0, h)
}

/// Battle-rig inputs, straight from the scene's battle state.
#[derive(Clone, Copy, Debug)]
pub struct RigInput {
    /// 0 = tele, 1 = wide (anything else falls back to tele).
    pub rig: u8,
    /// Q8 turn fraction around the arena (wraps).
    pub orbit_q8: i32,
    /// Q8 fraction of RIG_PITCH_MAX_DEG, clamped to 0..=1.
    pub pitch_q8: i32,
    /// Q8 zoom multiplier, clamped to RIG_ZOOM_MIN..=RIG_ZOOM_MAX.
    pub zoom_q8: i32,
    /// The tick clock (idle yaw pan + dolly drift derive from it).
    pub tick: u32,
    /// Arena midpoint between the two mons, world px.
    pub mid: Vec3,
    /// Yaw of the player->enemy axis around +Y; 0 = north (-Z), positive
    /// CCW seen from above. Both authored ARENA_SHAPEs stage north (yaw 0).
    pub axis_yaw: f32,
}

/// The mod's spread correction: how much of the mon-axis separation the
/// current view actually sees. `beta` = yaw angle between the (flattened)
/// view direction and the mon axis, `e` = camera elevation. 0 when sighting
/// straight down the axis at ground level, 1 side-on or top-down.
pub fn axis_span(beta: f32, e: f32) -> f32 {
    let s = sinf(beta) * cosf(e);
    sqrtf(s * s + sinf(e) * sinf(e))
}

/// One solved rig constant set.
struct RigConsts {
    side: f32,
    back: f32,
    height: f32,
    look_x: f32,
    look_y: f32,
    frame_h: f32,
}

const TELE: RigConsts = RigConsts {
    side: rig_tele::SIDE,
    back: rig_tele::BACK,
    height: rig_tele::HEIGHT,
    look_x: rig_tele::LOOK_X,
    look_y: rig_tele::LOOK_Y,
    frame_h: rig_tele::FRAME_H,
};
const WIDE: RigConsts = RigConsts {
    side: rig_wide::SIDE,
    back: rig_wide::BACK,
    height: rig_wide::HEIGHT,
    look_x: rig_wide::LOOK_X,
    look_y: rig_wide::LOOK_Y,
    frame_h: rig_wide::FRAME_H,
};

fn rotate_y(v: Vec3, ang: f32) -> Vec3 {
    let (s, c) = (sinf(ang), cosf(ang));
    vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c)
}

/// The battle staging camera (upstream BattleCam, solved constants).
///
/// The rig hangs its authored offset (side / back / height, world px) off
/// the arena midpoint in the mon-axis frame, then applies, in order: the
/// player's orbit plus the idle yaw pan (±RIG_PAN_YAW_DEG over
/// RIG_PAN_TICKS), the player's pitch steer (0..RIG_PITCH_MAX_DEG of extra
/// elevation), and the idle dolly (±RIG_DOLLY over RIG_DOLLY_TICKS). Zoom
/// divides the framed height. The framed height is frameH plus the mon gap
/// scaled by [`axis_span`] — the spread correction: a view down the axis
/// needs only frameH, a side-on view must also cover the projected gap.
pub fn battle(inp: &RigInput) -> Camera {
    let r = if inp.rig == 1 { &WIDE } else { &TELE };

    // Mon-axis frame: f = player->enemy, s = its starboard perpendicular.
    let f = vec3(sinf(inp.axis_yaw), 0.0, -cosf(inp.axis_yaw));
    let s = vec3(-f.z, 0.0, f.x);

    // Authored offset, behind the player looking up the axis.
    let base = s
        .scale(r.side)
        .add(vec3(0.0, r.height, 0.0))
        .sub(f.scale(r.back));

    // Orbit + idle pan (yaw around the midpoint).
    let orbit_frac = (inp.orbit_q8.rem_euclid(256)) as f32 / 256.0;
    let pan = RIG_PAN_YAW_DEG.to_radians()
        * sinf(TAU * (inp.tick % RIG_PAN_TICKS) as f32 / RIG_PAN_TICKS as f32);
    let o = rotate_y(base, orbit_frac * TAU + pan);

    // Pitch steer: extra elevation, then the idle dolly on the total length.
    let pitch = (inp.pitch_q8 as f32 / 256.0).clamp(0.0, 1.0) * RIG_PITCH_MAX_DEG.to_radians();
    let h_len = sqrtf(o.x * o.x + o.z * o.z).max(1e-3);
    let e0 = atan2f(o.y, h_len);
    let e = (e0 + pitch).min(0.49 * PI);
    let dolly =
        1.0 + RIG_DOLLY * sinf(TAU * (inp.tick % RIG_DOLLY_TICKS) as f32 / RIG_DOLLY_TICKS as f32);
    let len = o.length() * dolly;
    let h_dir = vec3(o.x / h_len, 0.0, o.z / h_len);
    let off = h_dir
        .scale(len * cosf(e))
        .add(vec3(0.0, len * sinf(e), 0.0));

    let eye = inp.mid.add(off);
    let look = inp
        .mid
        .add(rotate_y(s, orbit_frac * TAU + pan).scale(r.look_x))
        .add(vec3(0.0, r.look_y, 0.0));

    // Spread-corrected framed height -> fov at the look distance.
    let view = look.sub(eye);
    let dist = view.length().max(1e-3);
    let view_h = sqrtf(view.x * view.x + view.z * view.z).max(1e-6);
    let beta = {
        let vh = vec3(view.x / view_h, 0.0, view.z / view_h);
        // |sin| of the yaw angle between flattened view and the mon axis.
        let cross = vh.x * f.z - vh.z * f.x;
        let dot = (vh.x * f.x + vh.z * f.z).clamp(-1.0, 1.0);
        atan2f(
            if cross < 0.0 { -cross } else { cross },
            if dot < 0.0 { -dot } else { dot },
        )
    };
    let elev = atan2f(if view.y < 0.0 { -view.y } else { view.y }, view_h);
    let zoom = (inp.zoom_q8 as f32 / 256.0).clamp(RIG_ZOOM_MIN, RIG_ZOOM_MAX);
    let gap_px = (ARENA_GAP_CELLS * CELL_PX) as f32;
    let frame_h = (r.frame_h + gap_px * axis_span(beta, elev)) / zoom;
    let fov = 2.0 * atanf(frame_h * 0.5 / dist);

    // Billboard lean angle: the view direction's angle from straight down.
    let dirn = view.scale(1.0 / dist);
    let a = atan2f(view_h / dist, -dirn.y);

    finish(eye, look, Vec3::Y, a, fov, dist)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::{PITCH_RUNGS, VIEW_H, WORLD_VIEW_H};

    #[test]
    fn rung0_frames_exactly_world_view_h() {
        // Project (cx, 0, cy ± WORLD_VIEW_H/2) at rung 0: clip y = ±1.
        let (cx, cy) = (120.0, 68.0);
        let cam = orbit(cx, cy, PITCH_RUNGS[0]);
        let half = WORLD_VIEW_H as f32 / 2.0;
        let north = cam.vp.transform(vec3(cx, 0.0, cy - half), 1.0);
        let south = cam.vp.transform(vec3(cx, 0.0, cy + half), 1.0);
        assert!((north.y / north.w - 1.0).abs() < 1e-4, "north edge at +1");
        assert!((south.y / south.w + 1.0).abs() < 1e-4, "south edge at -1");
    }

    #[test]
    fn fov_is_the_focal_constant() {
        let cam = orbit(0.0, 0.0, 35.0);
        let want = 2.0 * atanf(1.0 / (2.0 * CAM_FOCAL));
        assert_eq!(cam.fov_y, want);
        assert!((want.to_degrees() - 53.130).abs() < 1e-2);
    }

    #[test]
    fn horizon_only_at_the_high_rungs() {
        for (i, &deg) in PITCH_RUNGS.iter().enumerate() {
            let cam = orbit(0.0, 0.0, deg);
            let row = horizon_row(&cam, VIEW_H);
            if i < 4 {
                assert_eq!(row, 0, "rung {i} keeps the horizon out of frame");
            } else {
                assert!(
                    row > 0 && row < VIEW_H,
                    "rung 4 horizon row {row} must be inside the frame"
                );
            }
        }
    }

    #[test]
    fn battle_rig_is_deterministic_and_sane() {
        let inp = RigInput {
            rig: 0,
            orbit_q8: 0,
            pitch_q8: 0,
            zoom_q8: 256,
            tick: 0,
            mid: vec3(160.0, 0.0, 200.0),
            axis_yaw: 0.0,
        };
        let a = battle(&inp);
        let b = battle(&inp);
        assert_eq!(a.vp.m, b.vp.m, "same inputs, same camera");
        // Tele is a long lens; wide is wide.
        let wide = battle(&RigInput { rig: 1, ..inp });
        assert!(a.fov_y < wide.fov_y);
        assert!(a.fov_y > 0.05 && wide.fov_y < PI * 0.75);
        // The eye stands off the midpoint and above the ground.
        assert!(a.eye.y > 0.0);
        assert!(a.eye.sub(inp.mid).length() > rig_tele::BACK * 0.5);
        // Drift moves the camera over time.
        let later = battle(&RigInput { tick: 400, ..inp });
        assert!(a.eye.sub(later.eye).length() > 1e-3);
        // axis_span endpoints.
        assert!(axis_span(0.0, 0.0).abs() < 1e-6);
        assert!((axis_span(PI / 2.0, 0.0) - 1.0).abs() < 1e-6);
        assert!((axis_span(0.0, PI / 2.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn tanf_shim_matches() {
        // Keep the shim honest on the one fn tests don't otherwise touch.
        use crate::math::tanf;
        assert!((tanf(0.5) - sinf(0.5) / cosf(0.5)).abs() < 1e-6);
    }
}
