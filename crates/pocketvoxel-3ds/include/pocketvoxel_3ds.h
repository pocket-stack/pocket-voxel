/*
 * pocketvoxel_3ds.h — the C ABI of `libpocketvoxel_3ds.a`, the Rust glue that
 * owns the Pocket Voxel guest surface, the retained Scene and the pak on the
 * Nintendo 3DS.
 *
 * Ownership, ported from crates/pocketvoxel-psp (the EBOOT):
 *
 *   Rust owns  the pak (parse, validation, the borrowed sections), the
 *              retained Scene, the `voxel` op table and its argument
 *              marshalling, the per-present draw::build, and the handover to
 *              pocketvoxel-pica.
 *   C owns     QuickJS (runtime, context, the guest bundle, globalThis.frame),
 *              citro3d, linearAlloc, the frame lifecycle, input, present.
 *
 * That is the opposite of the PSP split for QuickJS, and it matches the
 * PocketJS 3DS host (hosts/3ds/src/qjs.c): C unwraps JSValues and calls plain
 * C entry points, so **no JSValue ever crosses this boundary** and the 16-byte
 * JS_NO_NAN_BOXING JSValue ABI cannot be got wrong in two places.
 *
 * The op numbers, arities and semantics below are `crates/pocketvoxel-psp/src/
 * voxel.rs` transcribed, not re-derived. Op codes are append-only
 * (contracts/spec/voxel-spec.ts); nothing here renumbers them.
 *
 * The rendered frame is NOT handed over through this header: pv3ds_present()
 * records into pocketvoxel-pica, and the C side reads the command stream
 * through `pv_pica_frame()` in crates/pocketvoxel-pica/include/
 * pocketvoxel_pica.h, which also documents the GPU state each command means.
 */
#ifndef POCKETVOXEL_3DS_H
#define POCKETVOXEL_3DS_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ==========================================================================
 * Boot
 * ==========================================================================
 *
 * Order, and it is load-bearing:
 *
 *   1. linearAlloc the vertex/index arena  (PV3DS_ARENA_BYTES)
 *   2. pv3ds_init(arena, bytes, PV3DS_ARENA_BANKS)
 *   3. read voxelmon.vxpak into a 16-BYTE-ALIGNED buffer that is never freed
 *   4. pv3ds_load_pak(blob, len)
 *   5. create the QuickJS runtime, register globalThis.voxel (below), eval the
 *      guest bundle, look up globalThis.frame
 *
 * Step 3 before step 5 for the same reason the PSP EBOOT loads its pak first:
 * the pak is the single largest allocation of the run (32 MB for the shipped
 * one) and the QuickJS heap has to fit in what remains. On the 3DS the split
 * that decides "what remains" is fixed before main() — libctru carves the
 * linear heap out of APPMEMALLOC at startup and the rest becomes the malloc
 * heap — so the C side must size `__ctru_linear_heap_size` for the arena plus
 * pocketvoxel-pica's expanded textures (12.70 MiB, measured over the shipped
 * pak) and leave the pak plus the QuickJS heap room in the malloc heap.
 */

/* The arena sizing pocketvoxel-pica was budgeted against: two banks of 6 MiB.
 * pv3ds_init asserts nothing about the size it is handed — a smaller arena
 * drops draws it cannot stage and counts them in PvPicaStats.dropped_arena. */
#define PV3DS_ARENA_BYTES (12u * 1024u * 1024u)
#define PV3DS_ARENA_BANKS 2u

/*
 * Adopt the host's linear arena and reset the Scene. `arena` MUST be
 * linearAlloc memory: BufInfo_Add rejects any pointer below physical
 * 0x18000000, so malloc memory can never hold vertices. `banks >= 2` with a
 * C3D_FrameBegin(C3D_FRAME_SYNCDRAW) loop means the bank a present rewinds is
 * two frames old and the GPU is provably done with it.
 *
 * Returns 0, or -1 with pv3ds_last_error() set. Calling it again is a full
 * reset: a new Scene, and the arena re-adopted.
 */
int32_t pv3ds_init(void *arena, uint32_t arena_bytes, uint32_t banks);

/*
 * Parse and validate the pak, then hand its sections to the surface.
 *
 * `blob` must be **16-byte aligned** and must outlive the process: the pak's
 * vertex, index and texel pools are borrowed in place, never copied. The
 * reader itself rejects a blob whose pools are 2/4-byte misaligned; this
 * entry point rejects anything not 16-byte aligned outright, because that is
 * the alignment every VXPK section offset is a multiple of and the alignment
 * the staged copies inherit. `memalign(16, len)` and never free is the
 * intended C side.
 *
 * Returns 0, or -1 with pv3ds_last_error() set. Loading a pak resets the
 * Scene (the PSP EBOOT's voxel::init, which builds a fresh one).
 */
int32_t pv3ds_load_pak(const void *blob, uint32_t len);

/* NUL-terminated and static; empty when there is no error. */
const char *pv3ds_last_error(void);

/* ==========================================================================
 * The `voxel` surface — what globalThis.voxel must be
 * ==========================================================================
 *
 * PvVoxOp.kind says which entry point a trampoline calls. Every op has
 * exactly ONE entry point, and each dispatches the op into the Scene itself,
 * so calling two of them for one guest call double-counts.
 */

/* PvVoxOp.kind */
#define PV3DS_OP_NUMERIC   0 /* pv3ds_op         -> JS_UNDEFINED           */
#define PV3DS_OP_TEXT      1 /* pv3ds_op_text    -> JS_UNDEFINED           */
#define PV3DS_OP_GAMEDATA  2 /* pv3ds_gamedata   -> JS string              */
#define PV3DS_OP_AUDIODATA 3 /* pv3ds_audiodata  -> ArrayBuffer, or undef  */
#define PV3DS_OP_STATS     4 /* pv3ds_op_stats   -> JS_UNDEFINED           */

/* Longest name is "audioWaves" (10) — the field carries the NUL. */
#define PV3DS_OP_NAME_MAX 16

/*
 * One entry of the surface. 24 bytes, pointer-free on purpose: the same
 * layout on the armv6k device and on the host that unit-tests it.
 */
typedef struct {
  char name[PV3DS_OP_NAME_MAX]; /* property name on globalThis.voxel, NUL-terminated */
  uint32_t code;                /* VOX_OP code (contracts/spec/voxel-spec.ts) */
  uint8_t argc;                 /* numeric args the Scene is given */
  uint8_t js_len;               /* length to declare to JS_NewCFunction */
  uint8_t kind;                 /* PV3DS_OP_* */
  uint8_t reserved;
} PvVoxOp;

/* The table is fixed for the life of the process. */
uint32_t pv3ds_op_count(void);

/* Copy entry `index` into `out`. Returns 0, or -1 when `index` is past the
 * table or `out` is NULL. */
int32_t pv3ds_op_at(uint32_t index, PvVoxOp *out);

/*
 * Dispatch one PV3DS_OP_NUMERIC op. `args` are the guest's numeric arguments
 * in order; `argc` is how many it actually passed.
 *
 * Marshalling is the PSP host's, exactly: the Scene is always given the op's
 * declared `argc` arguments, so a **missing argument reads as 0** and a
 * surplus one is dropped. That defaulting is why `scene.op` sees a stable
 * arity and why a guest calling `voxel.cam(4)` moves the camera to (4, 0)
 * rather than throwing — native hosts are the non-strict kind, and a crash on
 * a handheld is worse than a wrong argument.
 *
 * Returns 0, or -1 (counted in PvVox3dsStats.ops_rejected) when the code is
 * not a numeric op in the table. A rejected call never reaches the Scene.
 */
int32_t pv3ds_op(uint32_t code, const int32_t *args, uint32_t argc);

/*
 * The one string-bearing op, `uiText(x, y, str)`: `args` carries x and y,
 * `text` the UTF-8 bytes (borrowed for the call only — JS_ToCStringLen2's
 * pointer is fine). A NULL pointer, or bytes that are not valid UTF-8, is a
 * no-op that never reaches the Scene, which is what the PSP host does with a
 * failed `core::str::from_utf8`.
 *
 * Returns 0, or -1.
 */
int32_t pv3ds_op_text(uint32_t code, const int32_t *args, uint32_t argc,
                      const char *text, uint32_t text_len);

/*
 * `voxel.gamedata()` — the pak's GAME section (gameplay JSON) as borrowed
 * bytes, for JS_NewStringLen. One cold parse at boot, then the guest never
 * crosses for data again. Dispatches op::GAMEDATA. Returns 0, or -1 when no
 * pak is loaded.
 */
int32_t pv3ds_gamedata(const uint8_t **bytes, uint32_t *len);

/*
 * `voxel.audiodata()` — the pak's AUDI section verbatim, for a zero-copy
 * JS_NewArrayBuffer over the leaked pak (free_func NULL: the pak outlives the
 * realm). Dispatches op::AUDIODATA. Returns 0, or -1 when there is no pak or
 * the section is empty — **-1 means return JS_UNDEFINED**, which the guest
 * reads as "this pak has no audio, run silent".
 */
int32_t pv3ds_audiodata(const uint8_t **bytes, uint32_t *len);

/*
 * `voxel.stats()` — dispatches op::STATS and writes the Scene's packed
 * counters (`u32 tick | u32 ops`, little-endian) into `out`, which must hold
 * 8 bytes or be NULL. The PSP host returns undefined regardless and the
 * guest's QuickJsHost expects null, so **return JS_UNDEFINED**; the payload is
 * here for a debug overlay, not for the guest. Returns 0, or -1.
 */
int32_t pv3ds_op_stats(uint8_t *out);

/*
 * Read-and-clear "this tick's ops re-showed map slot 0" — a warp landing. The
 * guest holds the world frozen through the fade, so it is the one moment a
 * long JS_RunGC is an invisible held cut rather than a hitch mid-walk; the
 * PSP EBOOT's arena-pressure GC collects exactly there. Call it EVERY tick:
 * a stale flag from a cheap early map show must not license a collection
 * later.
 */
uint8_t pv3ds_take_map_swapped(void);

/*
 * True once the guest has emitted any audio op. The 3DS build renders no PCM
 * (no audio module is mounted), so this is a signal for a host that adds one
 * later, and the reason it exists at all is that the audio ops still reach the
 * Scene: the chip synth's state advances with the tick clock whether or not
 * anything pumps it, exactly as it does in a PSP capture build.
 */
uint8_t pv3ds_audio_wanted(void);

/* ==========================================================================
 * The frame
 * ==========================================================================
 *
 * One guest tick, in the order the PSP EBOOT runs it and the order the sim's
 * replay records:
 *
 *   buttons -> JS globalThis.frame(buttons)   // ops land synchronously
 *   drain the QuickJS job queue
 *   pv3ds_tick()                              // scene.tick(): the tick clock
 *
 * The tick clock is the ONLY clock in the runtime (tile animation, cursors,
 * camera tweens), so it must advance at 60 Hz whatever the present rate is.
 * The PSP EBOOT runs two ticks per present and presents on an even 2-vblank
 * cadence; nothing here fixes that ratio, and PvVox3dsStats reports both
 * counts so the ratio a build actually ran is a measurement.
 */
void pv3ds_tick(void);

/*
 * Build this frame's DrawList from the Scene and record it into
 * pocketvoxel-pica. Returns 0, or -1 when no pak is loaded.
 *
 * Recording rewinds one arena bank, so it may only run once the GPU is done
 * with the frame that filled that bank — with PV3DS_ARENA_BANKS and
 * C3D_FRAME_SYNCDRAW that is two frames back. Afterwards:
 *
 *   const PvPicaFrame *f = pv_pica_frame();   // pocketvoxel_pica.h
 *   C3D_FrameBegin(C3D_FRAME_SYNCDRAW);
 *   C3D_FrameDrawOn(target);
 *   pv_pica_viewport(&x, &y, &w, &h);         // AFTER FrameDrawOn
 *   C3D_SetViewport(x, y, w, h);
 *   ... walk f->cmds ...
 *   C3D_FrameEnd(0);
 */
int32_t pv3ds_present(void);

/* This crate's counters, all since pv3ds_init. pocketvoxel-pica's own
 * (vertices staged, textures bound, arena high-water, dropped draws) come from
 * pv_pica_stats(). */
typedef struct {
  uint32_t ticks;        /* pv3ds_tick calls */
  uint32_t presents;     /* pv3ds_present calls that recorded */
  uint32_t ops;          /* ops dispatched into the Scene */
  uint32_t ops_rejected; /* calls refused before the Scene saw them */
  uint32_t scene_tick;   /* the Scene's own tick clock */
  uint32_t draw_items;   /* items in the last DrawList */
  uint32_t map_swaps;    /* mapShow(slot 0) calls since boot */
  uint32_t quality_tier; /* the rung in force — see below; always 0 */
} PvVox3dsStats;

void pv3ds_stats(PvVox3dsStats *out);

/* ==========================================================================
 * Input
 * ==========================================================================
 *
 * `globalThis.frame(buttons)` takes the abstract VOX_BTN mask
 * (contracts/spec/voxel-spec.ts §btn) — the same bits on every host, so one
 * input tape replays everywhere. The C side maps hidKeysHeld onto them; only
 * the analog rule lives here, because it is game policy rather than hardware.
 *
 * Confirm is the 3DS's **A**, cancel is **B**. The PSP EBOOT confirms on
 * CIRCLE and cancels on CROSS for the same reason — every PocketJS host
 * presses on the right-hand button of the diamond — so A and B land in the
 * same place under the same thumb, and X/Y are unmapped.
 *
 *   uint32_t buttons = 0;
 *   u32 held = hidKeysHeld();
 *   if (held & KEY_UP)     buttons |= PV3DS_BTN_UP;
 *   ... the rest of the d-pad, A, B, START, SELECT ...
 *   circlePosition cp; hidCircleRead(&cp);
 *   buttons |= pv3ds_axis_buttons(cp.dx, -cp.dy, 58);
 */
#define PV3DS_BTN_UP     1
#define PV3DS_BTN_DOWN   2
#define PV3DS_BTN_LEFT   4
#define PV3DS_BTN_RIGHT  8
#define PV3DS_BTN_A      16
#define PV3DS_BTN_B      32
#define PV3DS_BTN_START  64
#define PV3DS_BTN_SELECT 128

/*
 * The circle pad as one direction: past `deadzone` on either axis, the
 * DOMINANT axis wins and the other is discarded. The world is a walk grid, so
 * a diagonal push picks a lane instead of stuttering between two.
 *
 * `dy` is **screen-down positive** — the PSP nub's convention, which this rule
 * is transcribed from. libctru's circlePosition reports dy positive UP, so
 * pass `-cp.dy`.
 *
 * The PSP uses a deadzone of 48 on a 0..255 axis whose centre is 128, i.e.
 * 37.5% of full deflection; the circle pad's full deflection is about ±154, so
 * the same fraction is about 58. A well-used stick does not rest at centre,
 * which is what the deadzone is for.
 */
uint32_t pv3ds_axis_buttons(int32_t dx, int32_t dy, int32_t deadzone);

/* ==========================================================================
 * The quality rung
 * ==========================================================================
 *
 * There is deliberately no `quality` entry in the op table and no entry point
 * that sets one: the Scene stays on tier 0, the `psp` rung, which is
 * QUALITY_TIER_DEFAULT and the rung the shipped goldens were recorded at.
 * PvVox3dsStats.quality_tier reports it so the claim is observable at runtime.
 *
 * The ladder itself must not be touched to add a 3DS rung: tier ids are dense
 * and in declaration order, climbing is non-decreasing, and the last rung is
 * the identity anchored by the `-max.hashes` goldens under tests/goldens/voxel.
 * Inserting a weaker rung would renumber `desktop`.
 *
 * ==========================================================================
 * Registering the surface (the C side, sketched)
 * ==========================================================================
 *
 *   static JSValue voxel_call(JSContext *ctx, JSValueConst this_val,
 *                             int argc, JSValueConst *argv, int magic) {
 *     PvVoxOp op;
 *     if (pv3ds_op_at((uint32_t)magic, &op) != 0) return JS_UNDEFINED;
 *     int32_t args[8];
 *     uint32_t n = 0;
 *     for (; n < op.argc && (int)n < argc; n++) JS_ToInt32(ctx, &args[n], argv[n]);
 *     switch (op.kind) {
 *       case PV3DS_OP_NUMERIC:
 *         pv3ds_op(op.code, args, n);
 *         return JS_UNDEFINED;
 *       case PV3DS_OP_TEXT: {
 *         if (argc < (int)op.js_len) return JS_UNDEFINED;
 *         size_t len = 0;
 *         const char *s = JS_ToCStringLen2(ctx, &len, argv[op.argc], 0);
 *         if (s == NULL) return JS_UNDEFINED;
 *         pv3ds_op_text(op.code, args, n, s, (uint32_t)len);
 *         JS_FreeCString(ctx, s);
 *         return JS_UNDEFINED;
 *       }
 *       case PV3DS_OP_GAMEDATA: {
 *         const uint8_t *b; uint32_t len;
 *         if (pv3ds_gamedata(&b, &len) != 0) return JS_UNDEFINED;
 *         return JS_NewStringLen(ctx, (const char *)b, len);
 *       }
 *       case PV3DS_OP_AUDIODATA: {
 *         const uint8_t *b; uint32_t len;
 *         if (pv3ds_audiodata(&b, &len) != 0) return JS_UNDEFINED;
 *         return JS_NewArrayBuffer(ctx, (uint8_t *)b, len, NULL, NULL, 0);
 *       }
 *       case PV3DS_OP_STATS:
 *         pv3ds_op_stats(NULL);
 *         return JS_UNDEFINED;
 *     }
 *     return JS_UNDEFINED;
 *   }
 *
 *   JSValue voxel = JS_NewObject(ctx);
 *   for (uint32_t i = 0, n = pv3ds_op_count(); i < n; i++) {
 *     PvVoxOp op;
 *     if (pv3ds_op_at(i, &op) != 0) continue;
 *     JS_SetPropertyStr(ctx, voxel, op.name,
 *       JS_NewCFunctionMagic(ctx, voxel_call, op.name, op.js_len,
 *                            JS_CFUNC_generic_magic, (int)i));
 *   }
 *   JS_SetPropertyStr(ctx, global, "voxel", voxel);
 *
 * `JS_ToInt32` on a missing argument is never reached: the loop stops at the
 * guest's own argc and pv3ds_op zero-fills the rest, which is the PSP host's
 * `arg_i32` defaulting.
 */

#ifdef __cplusplus
}
#endif

#endif /* POCKETVOXEL_3DS_H */
