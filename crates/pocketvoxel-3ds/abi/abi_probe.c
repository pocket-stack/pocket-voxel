/*
 * abi_probe.c — the C half of the ABI check, compiled and linked under
 * devkitARM by `bun crates/pocketvoxel-3ds/abi/check.ts`.
 *
 * It does two things, and it is never run:
 *
 *  1. `_Static_assert`s every struct size and field offset the two headers
 *     declare, so the ARM compiler and the Rust `offset_of!` tests are pinned
 *     against each other instead of each against memory. Both structs on this
 *     boundary are deliberately pointer-free, which is what makes the host
 *     test's numbers mean anything for a 32-bit device.
 *  2. Takes the address of every declared entry point and links the result
 *     against libpocketvoxel_3ds.a, so a header that declares a function the
 *     archive does not export (a typo, a dropped `#[no_mangle]`, a signature
 *     that stopped being C) fails here rather than in the host's build.
 *
 * pocketvoxel_pica.h is asserted too: this is the same boundary — the C side
 * walks the command stream pv3ds_present() records — and its numbers had no C
 * check of their own.
 */

#include <stddef.h>
#include <stdint.h>

#include "pocketvoxel_3ds.h"
#include "pocketvoxel_pica.h"

/* -- pocketvoxel_3ds.h ---------------------------------------------------- */

_Static_assert(sizeof(PvVoxOp) == 24, "PvVoxOp is 24 bytes");
_Static_assert(_Alignof(PvVoxOp) == 4, "PvVoxOp aligns to 4");
_Static_assert(offsetof(PvVoxOp, name) == 0, "PvVoxOp.name");
_Static_assert(sizeof(((PvVoxOp *)0)->name) == 16, "PvVoxOp.name is 16 bytes");
_Static_assert(offsetof(PvVoxOp, code) == 16, "PvVoxOp.code");
_Static_assert(offsetof(PvVoxOp, argc) == 20, "PvVoxOp.argc");
_Static_assert(offsetof(PvVoxOp, js_len) == 21, "PvVoxOp.js_len");
_Static_assert(offsetof(PvVoxOp, kind) == 22, "PvVoxOp.kind");
_Static_assert(offsetof(PvVoxOp, reserved) == 23, "PvVoxOp.reserved");
_Static_assert(PV3DS_OP_NAME_MAX == 16, "PV3DS_OP_NAME_MAX");

_Static_assert(sizeof(PvVox3dsStats) == 32, "PvVox3dsStats is 32 bytes");
_Static_assert(_Alignof(PvVox3dsStats) == 4, "PvVox3dsStats aligns to 4");
_Static_assert(offsetof(PvVox3dsStats, ticks) == 0, "ticks");
_Static_assert(offsetof(PvVox3dsStats, presents) == 4, "presents");
_Static_assert(offsetof(PvVox3dsStats, ops) == 8, "ops");
_Static_assert(offsetof(PvVox3dsStats, ops_rejected) == 12, "ops_rejected");
_Static_assert(offsetof(PvVox3dsStats, scene_tick) == 16, "scene_tick");
_Static_assert(offsetof(PvVox3dsStats, draw_items) == 20, "draw_items");
_Static_assert(offsetof(PvVox3dsStats, map_swaps) == 24, "map_swaps");
_Static_assert(offsetof(PvVox3dsStats, quality_tier) == 28, "quality_tier");

/* The op kinds and the button bits are numbers two languages both hold. */
_Static_assert(PV3DS_OP_NUMERIC == 0 && PV3DS_OP_TEXT == 1 &&
                   PV3DS_OP_GAMEDATA == 2 && PV3DS_OP_AUDIODATA == 3 &&
                   PV3DS_OP_STATS == 4,
               "PV3DS_OP_* kinds");
_Static_assert(PV3DS_BTN_UP == 1 && PV3DS_BTN_DOWN == 2 && PV3DS_BTN_LEFT == 4 &&
                   PV3DS_BTN_RIGHT == 8 && PV3DS_BTN_A == 16 &&
                   PV3DS_BTN_B == 32 && PV3DS_BTN_START == 64 &&
                   PV3DS_BTN_SELECT == 128,
               "PV3DS_BTN_* is the VOX_BTN set");
_Static_assert(PV3DS_ARENA_BYTES == 12u * 1024u * 1024u, "PV3DS_ARENA_BYTES");
_Static_assert(PV3DS_ARENA_BANKS == 2u, "PV3DS_ARENA_BANKS");

/* -- pocketvoxel_pica.h --------------------------------------------------- */

_Static_assert(sizeof(PvPicaCmd) == 40, "PvPicaCmd is 40 bytes");
_Static_assert(offsetof(PvPicaCmd, kind) == 0, "PvPicaCmd.kind");
_Static_assert(offsetof(PvPicaCmd, vfmt) == 1, "PvPicaCmd.vfmt");
_Static_assert(offsetof(PvPicaCmd, depth) == 2, "PvPicaCmd.depth");
_Static_assert(offsetof(PvPicaCmd, flags) == 3, "PvPicaCmd.flags");
_Static_assert(offsetof(PvPicaCmd, page) == 4, "PvPicaCmd.page");
_Static_assert(offsetof(PvPicaCmd, frame) == 6, "PvPicaCmd.frame");
_Static_assert(offsetof(PvPicaCmd, pal) == 8, "PvPicaCmd.pal");
_Static_assert(offsetof(PvPicaCmd, mtx) == 10, "PvPicaCmd.mtx");
_Static_assert(offsetof(PvPicaCmd, vert_offset) == 12, "PvPicaCmd.vert_offset");
_Static_assert(offsetof(PvPicaCmd, vert_count) == 16, "PvPicaCmd.vert_count");
_Static_assert(offsetof(PvPicaCmd, index_offset) == 20, "PvPicaCmd.index_offset");
_Static_assert(offsetof(PvPicaCmd, index_count) == 24, "PvPicaCmd.index_count");
_Static_assert(offsetof(PvPicaCmd, clear_abgr) == 28, "PvPicaCmd.clear_abgr");
_Static_assert(offsetof(PvPicaCmd, uv_scale) == 32, "PvPicaCmd.uv_scale");
_Static_assert(sizeof(PvPicaTexKey) == 8, "PvPicaTexKey is 8 bytes");
_Static_assert(offsetof(PvPicaTexKey, tinted) == 6, "PvPicaTexKey.tinted");
_Static_assert(sizeof(PvPicaTexPlan) == 16, "PvPicaTexPlan is 16 bytes");
_Static_assert(offsetof(PvPicaTexPlan, width) == 4, "PvPicaTexPlan.width");
_Static_assert(offsetof(PvPicaTexPlan, u_scale) == 8, "PvPicaTexPlan.u_scale");
_Static_assert(sizeof(PvPicaStats) == 44, "PvPicaStats is 44 bytes");
_Static_assert(offsetof(PvPicaStats, uv_clamped) == 40, "PvPicaStats.uv_clamped");
_Static_assert(sizeof(PvPicaFrame) == 28, "PvPicaFrame is 28 bytes on ARM32");

/* -- every declared entry point resolves ---------------------------------- */

static const void *const entry_points[] = {
    (const void *)&pv3ds_init,
    (const void *)&pv3ds_load_pak,
    (const void *)&pv3ds_last_error,
    (const void *)&pv3ds_op_count,
    (const void *)&pv3ds_op_at,
    (const void *)&pv3ds_op,
    (const void *)&pv3ds_op_text,
    (const void *)&pv3ds_gamedata,
    (const void *)&pv3ds_audiodata,
    (const void *)&pv3ds_op_stats,
    (const void *)&pv3ds_take_map_swapped,
    (const void *)&pv3ds_audio_wanted,
    (const void *)&pv3ds_tick,
    (const void *)&pv3ds_present,
    (const void *)&pv3ds_stats,
    (const void *)&pv3ds_axis_buttons,
    (const void *)&pv_pica_init,
    (const void *)&pv_pica_last_error,
    (const void *)&pv_pica_frame,
    (const void *)&pv_pica_stats,
    (const void *)&pv_pica_viewport,
    (const void *)&pv_pica_tex_slot,
    (const void *)&pv_pica_tex_plan,
    (const void *)&pv_pica_tex_fill,
    (const void *)&pv_pica_tex_cost,
};

int main(void) {
  /* Never executed. The array is what forces every symbol into the link. */
  return entry_points[0] == NULL ? 1 : 0;
}
