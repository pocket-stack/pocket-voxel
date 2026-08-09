/* QuickJS: the `globalThis.voxel` surface and the per-tick guest turn. */
#ifndef POCKETVOXEL_3DS_QJS_H
#define POCKETVOXEL_3DS_QJS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Create the runtime, install `globalThis.voxel`, evaluate the bundled guest,
 * and latch `globalThis.frame`. False leaves voxel_qjs_last_error() set. */
bool voxel_qjs_boot(const char *source, size_t source_length);

/* One guest turn: `globalThis.frame(buttons)`, then the microtask queue. */
bool voxel_qjs_frame(int32_t buttons);

/* Run a full collection. Called on a warp landing, where the guest holds the
 * world frozen and the stall is an invisible held cut rather than a hitch. */
void voxel_qjs_collect(void);

const char *voxel_qjs_last_error(void);

void voxel_qjs_shutdown(void);

#endif /* POCKETVOXEL_3DS_QJS_H */
