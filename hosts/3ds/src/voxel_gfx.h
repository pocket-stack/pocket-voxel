/* The PICA200 command walker — see voxel_gfx.c. */
#ifndef POCKETVOXEL_3DS_GFX_H
#define POCKETVOXEL_3DS_GFX_H

#include <3ds.h>
#include <citro3d.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Build the shader program, the two attribute configurations and the
 * frame-constant GPU state. Call once, after C3D_Init. */
bool voxel_gfx_init(void);
void voxel_gfx_shutdown(void);

/*
 * Everything a recorded frame needs that must happen BEFORE C3D_FrameBegin:
 * the tilt pre-multiply over the matrix table, and the writeback of the
 * arena bytes the CPU just staged. Call after pv3_record().
 */
void voxel_gfx_prepare(void);

/*
 * The RGBA8 word for C3D_RenderTargetClear, taken from this frame's
 * PV_PICA_CMD_CLEAR. Valid after voxel_gfx_prepare().
 */
uint32_t voxel_gfx_clear_word(void);

/*
 * The letterboxed viewport in FRAMEBUFFER coordinates, ready for
 * C3D_SetViewport. Call it AFTER C3D_FrameDrawOn, which resets the viewport.
 */
void voxel_gfx_viewport(uint32_t *x, uint32_t *y, uint32_t *w, uint32_t *h);

/* Walk this frame's commands. Call inside C3D_FrameBegin/C3D_FrameEnd, after
 * C3D_FrameDrawOn and C3D_SetViewport. */
void voxel_gfx_render(void);

/*
 * Draws this frame did not issue: the crate's own arena and texture drops
 * plus any texture this side failed to create. A capture must never turn a
 * frame with a hole in it into a golden.
 */
uint32_t voxel_gfx_dropped(void);

/* One line of counters for the boot log, NUL-terminated. */
const char *voxel_gfx_stats_line(void);

/*
 * What the GPU is actually chewing on, NUL-terminated.
 *
 * Two facts the counter line above cannot carry, both of which a wedge needs:
 *
 *   THE FRAME IN FLIGHT. voxel_gfx_stats_line() reports the crate's LAST
 *   RECORD, and the frame loop records frame N before it waits for the GPU to
 *   finish frame N-1 — so at a frame-begin wedge those counters describe the
 *   frame that has NOT been submitted. This line describes the one that has.
 *
 *   WHERE THE WALK GOT TO. The command index, kind and page the walk last
 *   reached. A CPU-side stop (a texture expansion, a bind) leaves it on the
 *   command it stopped inside — the stage is `draw-walk` then. A GPU-side stop
 *   leaves it at the last command of the submitted frame, which is where a
 *   --max-draws bisect starts.
 */
const char *voxel_gfx_trace_line(void);

/* The compiled-in draw cap: -1 for none, else how many draw commands per frame
 * reach the GPU. Reported so a bisect build cannot be mistaken for a full one. */
int32_t voxel_gfx_max_draws(void);

#endif /* POCKETVOXEL_3DS_GFX_H */
