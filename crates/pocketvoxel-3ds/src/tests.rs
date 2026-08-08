//! Host-side tests for everything in this crate that does not need a GPU or a
//! QuickJS runtime.
//!
//! The oracle for the surface is `crates/pocketvoxel-psp/src/voxel.rs`: where
//! that file decides something the guest can observe — an op's code, its
//! arity, what a missing argument becomes, which ops mean "this run intends to
//! sound", when a warp landing is flagged — the expectation below is that
//! decision transcribed from its source, and the assertion is that this host
//! agrees with it exactly. The same guest bundle runs on both consoles, so a
//! disagreement is a divergence in the game, not a detail.
//!
//! What these cannot cover, because it is on the other side of the C ABI: that
//! the C side registers the table it is handed, that JSValues are unwrapped
//! the way the sketch in `include/pocketvoxel_3ds.h` says, and that the
//! recorded command stream draws the frame.

use super::*;

use std::sync::{Mutex, MutexGuard, OnceLock};

use pocketvoxel_core::pak::{
    AlignedBlob, MeshRange, PakVert,
    builder::{ChunkDef, PakBuilder},
};
use pocketvoxel_core::scene::Scene;
use pocketvoxel_core::spec::{self, Q4, atlas_kind, btn, mesh_kind, op};

use crate::cabi::VoxOp;
use crate::voxel::{MAX_ARGS, NAME_MAX};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// The runtime is one process-global host over pocketvoxel-pica's own global
/// renderer and pak, so tests that boot it take this.
fn serialized() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// A leaked 2 MiB stand-in for `linearAlloc` memory. Leaked because the pica
/// arena keeps the pointer for the life of the process, exactly as it does on
/// the device.
fn arena() -> (*mut std::ffi::c_void, u32) {
    const BYTES: usize = 2 * 1024 * 1024;
    static ARENA: OnceLock<usize> = OnceLock::new();
    let base = *ARENA.get_or_init(|| {
        let block: Box<[u8]> = std::vec![0u8; BYTES].into_boxed_slice();
        Box::leak(block).as_mut_ptr() as usize
    });
    (base as *mut std::ffi::c_void, BYTES as u32)
}

/// The device's own budget, for the one test that measures against real
/// content: two banks of 6 MiB, so the number it reports is what the shipped
/// arena would hold rather than what this test's arena capped it to.
fn device_arena() -> (*mut std::ffi::c_void, u32) {
    let bytes = pocketvoxel_pica::DEFAULT_ARENA_BYTES;
    static ARENA: OnceLock<usize> = OnceLock::new();
    let base = *ARENA.get_or_init(|| {
        let block: Box<[u8]> = std::vec![0u8; pocketvoxel_pica::DEFAULT_ARENA_BYTES].into_boxed_slice();
        Box::leak(block).as_mut_ptr() as usize
    });
    (base as *mut std::ffi::c_void, bytes as u32)
}

/// One map, one chunk with terrain and detail meshes, a sprite sheet, a UI
/// page and RED++ colour bindings — enough that `draw::build` emits every item
/// kind this backend has a pass for. The page sizes are deliberately not
/// powers of two, which is the case the POT envelope exists for.
fn demo_pak(with_audio: bool) -> std::vec::Vec<u8> {
    let mut b = PakBuilder::new();
    let mut pal = [0xff00_0000u32; 256];
    for (i, c) in pal.iter_mut().enumerate() {
        *c = 0xff00_0000 | (i as u32 * 0x0001_0101);
    }
    pal[0] = 0x0000_0000; // alpha-tested out
    for _ in 0..7 {
        b.palette(pal); // 0..3 kind ramps, 4 the SGB entry, 5 world, 6 OBJ
    }
    let terrain: std::vec::Vec<u8> = (0..40 * 24).map(|i| (i % 255 + 1) as u8).collect();
    b.atlas_linear(40, 24, atlas_kind::TERRAIN, &[&terrain]);
    b.atlas_linear(64, 128, atlas_kind::SPRITES, &[&std::vec![7u8; 64 * 128]]);
    b.atlas_linear(24, 24, atlas_kind::UI, &[&std::vec![9u8; 24 * 24]]);

    let quad = |b: &mut PakBuilder, x0: i16, z0: i16, x1: i16, z1: i16| {
        let v = |x, z| PakVert {
            u: 8192,
            v: 8192,
            abgr: 0xffff_ffff,
            x,
            y: 0,
            z,
            pad: 0,
        };
        b.mesh(&[v(x0, z0), v(x1, z0), v(x1, z1), v(x0, z1)], &[0, 1, 2, 0, 2, 3])
    };
    let mut meshes = [MeshRange::default(); spec::MESH_KINDS];
    meshes[mesh_kind::TERRAIN as usize] = quad(&mut b, 0, 0, 128, 128);
    meshes[mesh_kind::GRASS as usize] = quad(&mut b, 0, 0, 64, 64);
    meshes[mesh_kind::FLOWER as usize] = quad(&mut b, 64, 64, 128, 128);
    let stamp = quad(&mut b, 16, 16, 32, 32);
    b.map(
        7,
        &[ChunkDef {
            cx: 0,
            cy: 0,
            aabb_min: [0, 0, 0],
            aabb_max: [128, 0, 128],
            bake_page: spec::BAKE_PAGE_NONE,
            meshes,
        }],
    );
    b.stamps(7, &[(2, 2, stamp)]);
    b.glyph('A' as u16, 3);
    b.game(br#"{"maps":[]}"#);
    if with_audio {
        b.audio(br#"{"songs":[]}"#, &[0u8; 32]);
    }
    b.color_flags(spec::VXPK_COLOR_FLAG_WORLD);
    b.map_color(7, 5, 0);
    b.page_color(1, 6);
    b.finish()
}

/// The pak, 16-byte aligned and leaked: the reader borrows its pools in place,
/// so the blob has to outlive every frame — the same reason the C side is told
/// to `memalign(16, len)` and never free.
fn pak_blob(with_audio: bool) -> &'static [u8] {
    static WITH: OnceLock<&'static [u8]> = OnceLock::new();
    static WITHOUT: OnceLock<&'static [u8]> = OnceLock::new();
    let cell = if with_audio { &WITH } else { &WITHOUT };
    cell.get_or_init(|| {
        let blob: &'static AlignedBlob =
            Box::leak(Box::new(AlignedBlob::from_bytes(&demo_pak(with_audio))));
        blob.bytes()
    })
}

/// A booted runtime: arena adopted, pak loaded, Scene fresh.
fn boot(with_audio: bool) -> MutexGuard<'static, ()> {
    let guard = serialized();
    let (arena, bytes) = arena();
    unsafe {
        assert_eq!(cabi::pv3ds_init(arena, bytes, 2), 0, "{}", last_error());
        let blob = pak_blob(with_audio);
        assert_eq!(
            cabi::pv3ds_load_pak(blob.as_ptr() as *const _, blob.len() as u32),
            0,
            "{}",
            last_error()
        );
    }
    guard
}

fn last_error() -> std::string::String {
    unsafe {
        std::ffi::CStr::from_ptr(cabi::pv3ds_last_error())
            .to_string_lossy()
            .into_owned()
    }
}

fn stats() -> Stats {
    let mut s = Stats::default();
    unsafe { cabi::pv3ds_stats(&mut s) };
    s
}

fn op(code: u32, args: &[i32]) -> i32 {
    unsafe { cabi::pv3ds_op(code, args.as_ptr(), args.len() as u32) }
}

/// Everything the guest can move, as one comparable string. Every state type
/// in the Scene derives `Debug`, which makes this the cheapest total
/// comparison that does not need `PartialEq` added to the core.
fn fingerprint(s: &Scene) -> std::string::String {
    std::format!(
        "{:?}|{},{}|{},{},{}|{:08x}|{}|{:?}|{:?}|{:?}|{:?}|{}|{:?}|{}|{}",
        s.maps,
        s.cam_x,
        s.cam_y,
        s.pitch_rung,
        s.pitch_from_deg,
        s.pitch_t,
        s.tint,
        s.palette,
        s.stamps_off,
        s.ents,
        s.ui,
        s.ui_text,
        s.ui_reveal,
        s.battle,
        s.quality,
        s.tick,
    )
}

// ---------------------------------------------------------------------------
// 1. The table IS the PSP surface
// ---------------------------------------------------------------------------

/// `crates/pocketvoxel-psp/src/voxel.rs`'s `register()`, transcribed: the
/// property name, the `op_fn!`/`dispatch::<N>` arity, and the length passed to
/// `add_fn`. Reading this table against that function is the whole review.
const PSP_SURFACE: &[(&str, u32, u8, u8, u8)] = &[
    // name, code, argc, js_len (add_fn length), kind
    ("gamedata", 1, 0, 0, op_kind::GAMEDATA),
    ("audiodata", 17, 0, 0, op_kind::AUDIODATA),
    ("stats", 2, 0, 0, op_kind::STATS),
    ("reset", 3, 0, 0, op_kind::NUMERIC),
    ("mapShow", 10, 4, 4, op_kind::NUMERIC),
    ("mapHide", 11, 1, 1, op_kind::NUMERIC),
    ("cam", 12, 2, 2, op_kind::NUMERIC),
    ("pitch", 13, 1, 1, op_kind::NUMERIC),
    ("tint", 14, 1, 1, op_kind::NUMERIC),
    ("stamp", 15, 4, 4, op_kind::NUMERIC),
    ("palette", 16, 1, 1, op_kind::NUMERIC),
    ("ent", 30, 7, 7, op_kind::NUMERIC),
    ("entHide", 31, 1, 1, op_kind::NUMERIC),
    ("emote", 32, 2, 2, op_kind::NUMERIC),
    ("uiTile", 50, 3, 3, op_kind::NUMERIC),
    ("uiFill", 51, 5, 5, op_kind::NUMERIC),
    ("uiText", 52, 2, 3, op_kind::TEXT),
    ("uiReveal", 53, 1, 1, op_kind::NUMERIC),
    ("uiClear", 54, 0, 0, op_kind::NUMERIC),
    ("arena", 70, 5, 5, op_kind::NUMERIC),
    ("card", 71, 4, 4, op_kind::NUMERIC),
    ("cardHide", 72, 1, 1, op_kind::NUMERIC),
    ("battleCam", 73, 3, 3, op_kind::NUMERIC),
    ("arenaEnd", 74, 0, 0, op_kind::NUMERIC),
    ("music", 18, 4, 4, op_kind::NUMERIC),
    ("musicStop", 19, 0, 0, op_kind::NUMERIC),
    ("musicFade", 20, 1, 1, op_kind::NUMERIC),
    ("sfx", 21, 6, 6, op_kind::NUMERIC),
    ("cry", 22, 5, 5, op_kind::NUMERIC),
    ("audioWaves", 23, 3, 3, op_kind::NUMERIC),
    ("audioDrum", 24, 4, 4, op_kind::NUMERIC),
];

/// The ops the PSP host wraps in `audio_op_fn!` — the ones that mean "this run
/// intends to sound".
const PSP_AUDIO_OPS: &[&str] = &[
    "music",
    "musicStop",
    "musicFade",
    "sfx",
    "cry",
    "audioWaves",
    "audioDrum",
];

#[test]
fn the_table_is_the_psp_surface() {
    assert_eq!(OPS.len(), PSP_SURFACE.len(), "op count");
    for (i, (def, want)) in OPS.iter().zip(PSP_SURFACE.iter()).enumerate() {
        assert_eq!(def.name, want.0, "entry {i} name");
        assert_eq!(def.code, want.1, "{} code", def.name);
        assert_eq!(def.argc, want.2, "{} argc", def.name);
        assert_eq!(def.js_len, want.3, "{} js_len", def.name);
        assert_eq!(def.kind, want.4, "{} kind", def.name);
        assert_eq!(
            def.audio,
            PSP_AUDIO_OPS.contains(&def.name),
            "{} audio intent",
            def.name
        );
    }
}

/// Codes are the generated contract's, not numbers retyped here.
#[test]
fn every_code_is_the_generated_spec_code() {
    let spec_codes = [
        ("gamedata", op::GAMEDATA),
        ("audiodata", op::AUDIODATA),
        ("stats", op::STATS),
        ("reset", op::RESET),
        ("mapShow", op::MAP_SHOW),
        ("mapHide", op::MAP_HIDE),
        ("cam", op::CAM),
        ("pitch", op::PITCH),
        ("tint", op::TINT),
        ("stamp", op::STAMP),
        ("palette", op::PALETTE),
        ("ent", op::ENT),
        ("entHide", op::ENT_HIDE),
        ("emote", op::EMOTE),
        ("uiTile", op::UI_TILE),
        ("uiFill", op::UI_FILL),
        ("uiText", op::UI_TEXT),
        ("uiReveal", op::UI_REVEAL),
        ("uiClear", op::UI_CLEAR),
        ("arena", op::ARENA),
        ("card", op::CARD),
        ("cardHide", op::CARD_HIDE),
        ("battleCam", op::BATTLE_CAM),
        ("arenaEnd", op::ARENA_END),
        ("music", op::MUSIC),
        ("musicStop", op::MUSIC_STOP),
        ("musicFade", op::MUSIC_FADE),
        ("sfx", op::SFX),
        ("cry", op::CRY),
        ("audioWaves", op::AUDIO_WAVES),
        ("audioDrum", op::AUDIO_DRUM),
    ];
    for (name, code) in spec_codes {
        assert_eq!(
            voxel::find_by_name(name).map(|d| d.code),
            Some(code),
            "{name}"
        );
    }
}

/// The rung is not the guest's to change: the PSP EBOOT registers no
/// `quality` binding, so neither does this host, and the Scene keeps
/// QUALITY_TIER_DEFAULT for the whole run.
#[test]
fn there_is_no_quality_op() {
    assert!(voxel::find(op::QUALITY).is_none());
    assert!(voxel::find_by_name("quality").is_none());
}

// ---------------------------------------------------------------------------
// 2. Argument marshalling
// ---------------------------------------------------------------------------

/// The Scene is handed the op's declared arity every time: missing arguments
/// read as 0, surplus ones are dropped. Driven through the C entry point on
/// one side and `Scene::op` with the padded list on the other, so the
/// comparison is against the core's own dispatch and not against a
/// re-derivation of it.
#[test]
fn a_missing_argument_reads_as_zero() {
    let cases: &[(u32, &[i32], &[i32])] = &[
        // guest call            -> what the Scene must see
        (op::CAM, &[4 * Q4], &[4 * Q4, 0]),
        (op::CAM, &[1, 2, 3, 4], &[1, 2]),
        (op::MAP_SHOW, &[], &[0, 0, 0, 0]),
        (op::MAP_SHOW, &[1, 7], &[1, 7, 0, 0]),
        (op::ENT, &[0, 1], &[0, 1, 0, 0, 0, 0, 0]),
        (op::UI_TILE, &[3, 4, 5, 6], &[3, 4, 5]),
        (op::PITCH, &[2], &[2]),
        (op::UI_CLEAR, &[9], &[]),
    ];
    for (code, given, want) in cases {
        let _g = boot(true);
        let mut reference = Scene::new();
        reference.op(*code, want, None);
        assert_eq!(op(*code, given), 0, "op {code} refused");
        assert_eq!(
            fingerprint(cabi::host().scene()),
            fingerprint(&reference),
            "op {code} with {given:?} did not land as {want:?}"
        );
    }
}

/// The buffer the dispatch marshals into never allocates, so it has to be at
/// least as wide as the widest op.
#[test]
fn the_marshal_buffer_holds_the_widest_op() {
    let widest = OPS.iter().map(|d| d.argc).max().unwrap();
    assert_eq!(widest, 7, "ent is the widest op");
    assert!(widest as usize <= MAX_ARGS);
}

// ---------------------------------------------------------------------------
// 3. The two side effects an op has besides the Scene
// ---------------------------------------------------------------------------

/// `mapShow` on slot 0 is a warp landing. The flag is read from the same
/// defaulted argument the Scene is about to read, so a no-argument call trips
/// it exactly as it does on the PSP.
#[test]
fn map_show_slot_zero_flags_the_warp_landing() {
    let _g = boot(true);
    assert_eq!(unsafe { cabi::pv3ds_take_map_swapped() }, 0, "fresh boot");

    op(op::MAP_SHOW, &[1, 7, 0, 0]);
    assert_eq!(
        unsafe { cabi::pv3ds_take_map_swapped() },
        0,
        "a neighbour slot is not a landing"
    );

    op(op::MAP_SHOW, &[0, 7, 0, 0]);
    assert_eq!(unsafe { cabi::pv3ds_take_map_swapped() }, 1);
    assert_eq!(
        unsafe { cabi::pv3ds_take_map_swapped() },
        0,
        "reading clears it"
    );

    op(op::MAP_SHOW, &[]); // argument 0 defaults to 0 — still a landing
    assert_eq!(unsafe { cabi::pv3ds_take_map_swapped() }, 1);
    assert_eq!(stats().map_swaps, 2);
}

/// Exactly the seven `audio_op_fn!` ops raise the intent flag, and no other op
/// does — the host side uses it to decide whether to reserve hardware at all.
#[test]
fn only_the_audio_ops_mean_the_run_intends_to_sound() {
    for def in OPS {
        let _g = boot(true);
        assert_eq!(unsafe { cabi::pv3ds_audio_wanted() }, 0, "fresh boot");
        match def.kind {
            op_kind::NUMERIC => {
                op(def.code, &[0; MAX_ARGS]);
            }
            op_kind::TEXT => {
                let text = "hi";
                unsafe {
                    cabi::pv3ds_op_text(
                        def.code,
                        [0i32, 0].as_ptr(),
                        2,
                        text.as_ptr() as *const _,
                        text.len() as u32,
                    )
                };
            }
            op_kind::GAMEDATA => unsafe {
                cabi::pv3ds_gamedata(core::ptr::null_mut(), core::ptr::null_mut());
            },
            op_kind::AUDIODATA => unsafe {
                cabi::pv3ds_audiodata(core::ptr::null_mut(), core::ptr::null_mut());
            },
            op_kind::STATS => unsafe {
                cabi::pv3ds_op_stats(core::ptr::null_mut());
            },
            _ => unreachable!(),
        }
        assert_eq!(
            unsafe { cabi::pv3ds_audio_wanted() },
            u8::from(PSP_AUDIO_OPS.contains(&def.name)),
            "{} audio intent",
            def.name
        );
    }
}

// ---------------------------------------------------------------------------
// 4. The string op and the data ops
// ---------------------------------------------------------------------------

#[test]
fn ui_text_carries_the_string_and_refuses_anything_else() {
    let _g = boot(true);
    let text = "HELLO";
    assert_eq!(
        unsafe {
            cabi::pv3ds_op_text(
                op::UI_TEXT,
                [2i32, 3].as_ptr(),
                2,
                text.as_ptr() as *const _,
                text.len() as u32,
            )
        },
        0
    );
    let ui_text = cabi::host().scene().ui_text.clone().expect("a text run");
    assert_eq!((ui_text.x, ui_text.y, ui_text.text.as_str()), (2, 3, "HELLO"));

    // Not UTF-8: the PSP host's `from_utf8` fails and the op never reaches the
    // Scene. Same here, and it is counted as a refusal rather than silently
    // dropped.
    let before = stats();
    let bad = [0xffu8, 0xfe];
    assert_eq!(
        unsafe {
            cabi::pv3ds_op_text(
                op::UI_TEXT,
                [9i32, 9].as_ptr(),
                2,
                bad.as_ptr() as *const _,
                bad.len() as u32,
            )
        },
        -1
    );
    // A null string is the same refusal.
    assert_eq!(
        unsafe { cabi::pv3ds_op_text(op::UI_TEXT, core::ptr::null(), 0, core::ptr::null(), 0) },
        -1
    );
    let after = stats();
    assert_eq!(after.ops, before.ops, "no op reached the Scene");
    assert_eq!(after.ops_rejected, before.ops_rejected + 2);
    let unchanged = cabi::host().scene().ui_text.clone().unwrap();
    assert_eq!(unchanged.text.as_str(), "HELLO");
}

#[test]
fn each_op_has_exactly_one_entry_point() {
    let _g = boot(true);
    // A numeric op refuses the text entry point and vice versa; the three data
    // ops refuse both, because each dispatches its own op and taking two paths
    // would count the guest's one call twice.
    assert_eq!(op(op::UI_TEXT, &[1, 2]), -1, "uiText is not numeric");
    assert_eq!(op(op::GAMEDATA, &[]), -1);
    assert_eq!(op(op::AUDIODATA, &[]), -1);
    assert_eq!(op(op::STATS, &[]), -1);
    let t = "x";
    assert_eq!(
        unsafe {
            cabi::pv3ds_op_text(op::CAM, [0i32, 0].as_ptr(), 2, t.as_ptr() as *const _, 1)
        },
        -1,
        "cam takes no string"
    );
}

#[test]
fn an_unknown_code_never_reaches_the_scene() {
    let _g = boot(true);
    let before = stats();
    assert_eq!(op(9999, &[1, 2, 3]), -1);
    let after = stats();
    assert_eq!(after.ops, before.ops);
    assert_eq!(after.ops_rejected, before.ops_rejected + 1);
    assert_eq!(after.scene_tick, before.scene_tick);
}

#[test]
fn gamedata_is_the_paks_game_section() {
    let _g = boot(true);
    let (mut ptr, mut len) = (core::ptr::null::<u8>(), 0u32);
    assert_eq!(unsafe { cabi::pv3ds_gamedata(&mut ptr, &mut len) }, 0);
    let bytes = unsafe { core::slice::from_raw_parts(ptr, len as usize) };
    assert_eq!(bytes, br#"{"maps":[]}"#);
    // The op still went through the Scene, so its counter moved: the PSP host
    // dispatches before answering.
    assert_eq!(stats().ops, 1);
}

#[test]
fn audiodata_is_undefined_when_the_pak_carries_no_audio() {
    {
        let _g = boot(true);
        let (mut ptr, mut len) = (core::ptr::null::<u8>(), 0u32);
        assert_eq!(unsafe { cabi::pv3ds_audiodata(&mut ptr, &mut len) }, 0);
        assert!(len > 0, "the AUDI section is there");
    }
    let _g = boot(false);
    let (mut ptr, mut len) = (core::ptr::null::<u8>(), 0u32);
    assert_eq!(
        unsafe { cabi::pv3ds_audiodata(&mut ptr, &mut len) },
        -1,
        "an empty section answers undefined"
    );
    assert_eq!(stats().ops, 1, "and the op was still dispatched");
}

#[test]
fn stats_answers_the_cores_packed_counters() {
    let _g = boot(true);
    unsafe { cabi::pv3ds_tick() };
    unsafe { cabi::pv3ds_tick() };
    let mut packed = [0u8; 8];
    assert_eq!(unsafe { cabi::pv3ds_op_stats(packed.as_mut_ptr()) }, 0);
    assert_eq!(u32::from_le_bytes(packed[0..4].try_into().unwrap()), 2, "tick");
    assert_eq!(
        u32::from_le_bytes(packed[4..8].try_into().unwrap()),
        1,
        "ops, counting this one"
    );
}

// ---------------------------------------------------------------------------
// 5. Pak loading
// ---------------------------------------------------------------------------

#[test]
fn a_misaligned_pak_is_refused() {
    let _g = serialized();
    let (arena, bytes) = arena();
    unsafe { assert_eq!(cabi::pv3ds_init(arena, bytes, 2), 0) };
    let blob = pak_blob(true);
    // One byte in: every VXPK section offset is a multiple of 16, so the
    // borrowed pools only line up when the base does.
    let skewed = unsafe { blob.as_ptr().add(1) };
    assert_eq!(
        unsafe { cabi::pv3ds_load_pak(skewed as *const _, blob.len() as u32 - 1) },
        -1
    );
    assert!(last_error().contains("16-byte aligned"), "{}", last_error());
}

#[test]
fn a_truncated_pak_is_refused() {
    let _g = serialized();
    let (arena, bytes) = arena();
    unsafe { assert_eq!(cabi::pv3ds_init(arena, bytes, 2), 0) };
    let blob = pak_blob(true);
    assert_eq!(
        unsafe { cabi::pv3ds_load_pak(blob.as_ptr() as *const _, blob.len() as u32 - 16) },
        -1
    );
    assert!(!last_error().is_empty());
    assert_eq!(
        unsafe { cabi::pv3ds_load_pak(core::ptr::null(), 0) },
        -1,
        "a null blob too"
    );
}

#[test]
fn a_pak_cannot_load_before_the_arena_is_adopted() {
    let _g = serialized();
    // A null arena is what a failed linearAlloc hands over.
    assert_eq!(
        unsafe { cabi::pv3ds_init(core::ptr::null_mut(), 0, 2) },
        -1,
        "an empty arena is reported at init"
    );
    let blob = pak_blob(true);
    assert_eq!(
        unsafe { cabi::pv3ds_load_pak(blob.as_ptr() as *const _, blob.len() as u32) },
        -1
    );
    assert!(last_error().contains("pv3ds_init"), "{}", last_error());
}

#[test]
fn loading_a_pak_starts_a_fresh_scene() {
    let _g = boot(true);
    op(op::CAM, &[99 * Q4, 99 * Q4]);
    unsafe { cabi::pv3ds_tick() };
    let blob = pak_blob(true);
    assert_eq!(
        unsafe { cabi::pv3ds_load_pak(blob.as_ptr() as *const _, blob.len() as u32) },
        0
    );
    assert_eq!(fingerprint(cabi::host().scene()), fingerprint(&Scene::new()));
}

// ---------------------------------------------------------------------------
// 6. Tick and present
// ---------------------------------------------------------------------------

#[test]
fn the_tick_clock_is_the_scenes() {
    let _g = boot(true);
    for i in 0..5u32 {
        assert_eq!(stats().scene_tick, i);
        unsafe { cabi::pv3ds_tick() };
    }
    assert_eq!(stats().ticks, 5);
    assert_eq!(stats().scene_tick, 5);
}

/// A boot that never found a pak file draws nothing rather than drawing the
/// last process's frame: the retained parse belongs to the host, so
/// `pv3ds_init` clears it even though pocketvoxel-pica still holds the
/// storage.
#[test]
fn present_without_a_pak_is_refused() {
    let _g = boot(true);
    let (arena, bytes) = arena();
    unsafe { assert_eq!(cabi::pv3ds_init(arena, bytes, 2), 0) };
    assert!(cabi::host().pak().is_none());
    assert_eq!(unsafe { cabi::pv3ds_present() }, -1);
    assert!(last_error().contains("no pak"), "{}", last_error());
    assert_eq!(stats().presents, 0);
}

/// One present records a whole frame: the sky pass's clear plus the map's
/// draws, with nothing dropped for want of arena.
#[test]
fn present_records_the_frame() {
    let _g = boot(true);
    op(op::MAP_SHOW, &[0, 7, 0, 0]);
    op(op::CAM, &[64 * Q4, 64 * Q4]);
    op(op::PITCH, &[4]);
    unsafe { cabi::pv3ds_tick() };
    assert_eq!(unsafe { cabi::pv3ds_present() }, 0, "{}", last_error());

    let s = stats();
    assert_eq!(s.presents, 1);
    assert!(s.draw_items > 1, "sky plus geometry, got {}", s.draw_items);

    let pica = pocketvoxel_pica::global().stats();
    assert!(pica.commands >= 2, "clear plus at least one draw");
    assert!(pica.draws >= 1);
    assert_eq!(pica.dropped_arena, 0, "the test arena held the frame");
    assert_eq!(pica.dropped_texture, 0, "every draw resolved a palette");
    assert!(pica.verts > 0 && pica.indices > 0);
    assert!(pica.arena_used > 0 && pica.arena_used <= pica.arena_high_water);
}

/// The tick clock and the present rate are independent: the PSP EBOOT runs two
/// ticks per present, and nothing in this crate fixes the ratio.
#[test]
fn ticks_and_presents_are_independent() {
    let _g = boot(true);
    op(op::MAP_SHOW, &[0, 7, 0, 0]);
    for _ in 0..3 {
        unsafe {
            cabi::pv3ds_tick();
            cabi::pv3ds_tick();
            assert_eq!(cabi::pv3ds_present(), 0);
        }
    }
    let s = stats();
    assert_eq!((s.ticks, s.presents, s.scene_tick), (6, 3, 6));
}

/// The frame a present records is the frame the ops asked for: moving the
/// camera between two presents changes the recorded stream.
#[test]
fn a_present_reflects_the_ops_that_preceded_it() {
    let _g = boot(true);
    op(op::MAP_SHOW, &[0, 7, 0, 0]);
    op(op::CAM, &[64 * Q4, 64 * Q4]);
    unsafe { cabi::pv3ds_present() };
    let near = pocketvoxel_pica::global().stats();

    // 4000 world px away: the chunk-distance dial drops the map entirely.
    op(op::CAM, &[4000 * Q4, 4000 * Q4]);
    unsafe { cabi::pv3ds_present() };
    let far = pocketvoxel_pica::global().stats();
    assert!(
        far.draws < near.draws,
        "distance culls: {} then {}",
        near.draws,
        far.draws
    );
}

/// The shipped 32 MB pak, when it is on this machine, through the real entry
/// points: it is the only content that answers "does the budgeted arena hold a
/// real frame". `dist/` is ROM-derived and git-ignored, so the test skips
/// itself rather than failing on a checkout that has not cooked one.
///
/// The camera is aimed at the first chunk of the first map, which is a
/// coarse aim: what it proves is that a 30.6 MiB blob parses, that the map's
/// meshes stage, and what one such frame costs. `cargo test --manifest-path
/// crates/pocketvoxel-3ds/Cargo.toml -- --nocapture the_shipped_pak` prints
/// the numbers.
#[test]
fn the_shipped_pak_loads_and_records_a_frame() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../dist/voxelmon/voxelmon.vxpak");
    let Ok(bytes) = std::fs::read(path) else {
        std::eprintln!("skipped: {path} is not on this machine (dist/ is git-ignored)");
        return;
    };
    let _g = serialized();
    // The C side is told to `memalign(16, len)`; AlignedBlob is the same
    // guarantee, and leaking it is the same never-free lifetime.
    let blob: &'static AlignedBlob = Box::leak(Box::new(AlignedBlob::from_bytes(&bytes)));
    let blob = blob.bytes();
    assert!((blob.as_ptr() as usize).is_multiple_of(16));

    let (arena, arena_bytes) = device_arena();
    unsafe {
        assert_eq!(cabi::pv3ds_init(arena, arena_bytes, 2), 0, "{}", last_error());
        assert_eq!(
            cabi::pv3ds_load_pak(blob.as_ptr() as *const _, blob.len() as u32),
            0,
            "{}",
            last_error()
        );
    }
    let pak = cabi::host().pak().expect("the pak");
    std::eprintln!(
        "shipped pak: {} bytes, {} maps, {} chunks, {} verts, {} atlases, {} KB game",
        blob.len(),
        pak.maps.len(),
        pak.chunks.len(),
        pak.verts.len(),
        pak.atlases.len(),
        pak.game.len() / 1024,
    );

    // Every chunk of every map, at the pitch rung that puts the horizon on
    // screen (rung 4, the widest draw list the orbit reaches). Aiming at each
    // chunk centre in turn is a coarse sweep, not the story tape, but it is
    // the same content the device would stage and the worst frame of it is a
    // real number to put against the 6 MiB bank.
    let mut worst = (0u32, 0u32, 0u32, 0u32); // arena bytes, verts, draws, items
    let mut dropped = (0u32, 0u32);
    let mut frames = 0u32;
    for map in pak.maps.clone() {
        op(op::MAP_SHOW, &[0, map.map_id as i32, 0, 0]);
        op(op::PITCH, &[4]);
        for c in map.first..map.first + map.count {
            let chunk = &pak.chunks[c as usize];
            op(
                op::CAM,
                &[
                    (chunk.cx as i32 * spec::CHUNK_PX + spec::CHUNK_PX / 2) * Q4,
                    (chunk.cy as i32 * spec::CHUNK_PX + spec::CHUNK_PX / 2) * Q4,
                ],
            );
            unsafe {
                cabi::pv3ds_tick();
                assert_eq!(cabi::pv3ds_present(), 0, "{}", last_error());
            }
            frames += 1;
            let s = stats();
            let pica = pocketvoxel_pica::global().stats();
            dropped = (dropped.0 + pica.dropped_arena, dropped.1 + pica.dropped_texture);
            if pica.arena_used > worst.0 {
                worst = (pica.arena_used, pica.verts, pica.draws, s.draw_items);
            }
        }
    }
    let bank_kb = arena_bytes / 2 / 1024;
    std::eprintln!(
        "{frames} frames swept; worst frame {} KB of the {bank_kb} KB bank ({}%), {} verts, {} draws, {} items; dropped {} arena / {} texture",
        worst.0 / 1024,
        worst.0 / 1024 * 100 / bank_kb,
        worst.1,
        worst.2,
        worst.3,
        dropped.0,
        dropped.1,
    );
    assert!(frames > 0);
    assert!(worst.3 > 1, "a real map draws something");
    assert_eq!(dropped, (0, 0), "nothing dropped at the budgeted arena size");
}

// ---------------------------------------------------------------------------
// 7. The rung
// ---------------------------------------------------------------------------

/// The host never climbs the ladder, and neither `reset` nor a full run of ops
/// moves it: tier 0 is the `psp` rung and the rung the goldens were recorded
/// at.
#[test]
fn the_rung_stays_tier_zero() {
    let _g = boot(true);
    assert_eq!(stats().quality_tier, 0);
    for def in OPS.iter().filter(|d| d.kind == op_kind::NUMERIC) {
        op(def.code, &[1; MAX_ARGS]);
    }
    op(op::RESET, &[]);
    unsafe { cabi::pv3ds_tick() };
    assert_eq!(stats().quality_tier, 0);
    assert_eq!(
        cabi::host().scene().quality,
        spec::QUALITY_TIER_DEFAULT,
        "the Scene's own field"
    );
}

// ---------------------------------------------------------------------------
// 8. Input
// ---------------------------------------------------------------------------

/// `crates/pocketvoxel-psp/src/main.rs`'s `map_buttons` analog half,
/// transcribed: past the deadzone on either axis, the dominant axis wins.
fn psp_analog(dx: i32, dy: i32, deadzone: i32) -> u32 {
    let mut mask = 0;
    if dx.abs() > deadzone || dy.abs() > deadzone {
        if dx.abs() > dy.abs() {
            mask |= if dx < 0 { btn::LEFT } else { btn::RIGHT };
        } else {
            mask |= if dy < 0 { btn::UP } else { btn::DOWN };
        }
    }
    mask
}

#[test]
fn the_stick_picks_one_lane_the_way_the_psp_does() {
    for dx in -160..=160 {
        for dy in [-160, -60, -49, -48, -1, 0, 1, 48, 49, 60, 160] {
            assert_eq!(
                cabi::pv3ds_axis_buttons(dx, dy, 48),
                psp_analog(dx, dy, 48),
                "dx {dx} dy {dy}"
            );
        }
    }
    // The bits are the contract's, not this crate's.
    assert_eq!(cabi::pv3ds_axis_buttons(-100, 0, 48), btn::LEFT);
    assert_eq!(cabi::pv3ds_axis_buttons(100, 0, 48), btn::RIGHT);
    assert_eq!(cabi::pv3ds_axis_buttons(0, -100, 48), btn::UP);
    assert_eq!(cabi::pv3ds_axis_buttons(0, 100, 48), btn::DOWN);
    assert_eq!(cabi::pv3ds_axis_buttons(20, 20, 48), 0, "inside the deadzone");
    // A tie goes to the vertical axis, exactly as the PSP's `>` does.
    assert_eq!(cabi::pv3ds_axis_buttons(60, 60, 48), btn::DOWN);
    // No panic at the extremes (`saturating_abs`).
    assert_eq!(cabi::pv3ds_axis_buttons(i32::MIN, 0, 48), btn::LEFT);
}

/// The button bits the header publishes are the contract's own.
#[test]
fn the_published_button_bits_are_the_spec_bits() {
    assert_eq!(
        [
            btn::UP,
            btn::DOWN,
            btn::LEFT,
            btn::RIGHT,
            btn::A,
            btn::B,
            btn::START,
            btn::SELECT
        ],
        [1, 2, 4, 8, 16, 32, 64, 128],
        "PV3DS_BTN_* in include/pocketvoxel_3ds.h"
    );
}

// ---------------------------------------------------------------------------
// 9. The C ABI
// ---------------------------------------------------------------------------

/// The exact layout `include/pocketvoxel_3ds.h` declares. `abi/abi_probe.c`
/// `_Static_assert`s the same numbers under devkitARM, so the two sides of the
/// boundary are pinned against each other rather than against memory. Both
/// structs are pointer-free, which is what makes this host check meaningful
/// for a 32-bit device.
#[test]
fn abi_layout() {
    use core::mem::{align_of, offset_of, size_of};

    assert_eq!(size_of::<VoxOp>(), 24);
    assert_eq!(align_of::<VoxOp>(), 4);
    for (field, got, want) in [
        ("name", offset_of!(VoxOp, name), 0),
        ("code", offset_of!(VoxOp, code), 16),
        ("argc", offset_of!(VoxOp, argc), 20),
        ("js_len", offset_of!(VoxOp, js_len), 21),
        ("kind", offset_of!(VoxOp, kind), 22),
        ("reserved", offset_of!(VoxOp, reserved), 23),
    ] {
        assert_eq!(got, want, "PvVoxOp.{field}");
    }

    assert_eq!(size_of::<Stats>(), 32);
    assert_eq!(align_of::<Stats>(), 4);
    for (field, got, want) in [
        ("ticks", offset_of!(Stats, ticks), 0),
        ("presents", offset_of!(Stats, presents), 4),
        ("ops", offset_of!(Stats, ops), 8),
        ("ops_rejected", offset_of!(Stats, ops_rejected), 12),
        ("scene_tick", offset_of!(Stats, scene_tick), 16),
        ("draw_items", offset_of!(Stats, draw_items), 20),
        ("map_swaps", offset_of!(Stats, map_swaps), 24),
        ("quality_tier", offset_of!(Stats, quality_tier), 28),
    ] {
        assert_eq!(got, want, "PvVox3dsStats.{field}");
    }
    assert_eq!(NAME_MAX, 16, "PV3DS_OP_NAME_MAX");
    assert_eq!(
        [
            op_kind::NUMERIC,
            op_kind::TEXT,
            op_kind::GAMEDATA,
            op_kind::AUDIODATA,
            op_kind::STATS
        ],
        [0, 1, 2, 3, 4],
        "PV3DS_OP_* in include/pocketvoxel_3ds.h"
    );
}

/// The table crosses by index, and every name fits the inline field with room
/// for its NUL.
#[test]
fn op_at_hands_over_the_whole_table() {
    assert_eq!(cabi::pv3ds_op_count() as usize, OPS.len());
    for (i, def) in OPS.iter().enumerate() {
        let mut out = VoxOp {
            name: [0xff; NAME_MAX],
            code: 0,
            argc: 0,
            js_len: 0,
            kind: 0,
            reserved: 0xff,
        };
        assert_eq!(unsafe { cabi::pv3ds_op_at(i as u32, &mut out) }, 0);
        let nul = out.name.iter().position(|&b| b == 0).expect("NUL-terminated");
        assert_eq!(core::str::from_utf8(&out.name[..nul]).unwrap(), def.name);
        assert_eq!((out.code, out.argc, out.js_len, out.kind), (def.code, def.argc, def.js_len, def.kind));
        assert_eq!(out.reserved, 0);
    }
    let mut out = VoxOp {
        name: [0; NAME_MAX],
        code: 0,
        argc: 0,
        js_len: 0,
        kind: 0,
        reserved: 0,
    };
    assert_eq!(
        unsafe { cabi::pv3ds_op_at(OPS.len() as u32, &mut out) },
        -1,
        "past the end"
    );
    assert_eq!(unsafe { cabi::pv3ds_op_at(0, core::ptr::null_mut()) }, -1);
}

/// The arena numbers the header publishes are pocketvoxel-pica's own budget,
/// not a second opinion.
#[test]
fn the_published_arena_defaults_are_picas() {
    assert_eq!(
        pocketvoxel_pica::DEFAULT_ARENA_BYTES,
        12 * 1024 * 1024,
        "PV3DS_ARENA_BYTES"
    );
    assert_eq!(pocketvoxel_pica::DEFAULT_ARENA_BANKS, 2, "PV3DS_ARENA_BANKS");
}

/// Null out-pointers are legal everywhere they are accepted, because a C
/// caller that only wants the return code should not have to invent storage.
#[test]
fn null_out_pointers_are_tolerated() {
    let _g = boot(true);
    unsafe {
        cabi::pv3ds_stats(core::ptr::null_mut());
        assert_eq!(cabi::pv3ds_gamedata(core::ptr::null_mut(), core::ptr::null_mut()), 0);
        assert_eq!(cabi::pv3ds_op_stats(core::ptr::null_mut()), 0);
        assert_eq!(cabi::pv3ds_op(op::CAM, core::ptr::null(), 0), 0);
    }
}
