/*
 * 3DS keys onto VOX_BTN.
 *
 * The masks are the spec's (`contracts/spec/voxel-spec.ts` §btn), republished
 * by the crate as PV3DS_BTN_*, so one input tape replays on every host.
 *
 * A and B keep the console's own meaning. On the PSP the EBOOT maps CIRCLE to
 * confirm because that is what the rest of the PocketJS family does on that
 * stick; on a 3DS the confirm button IS A, so the mapping is direct and a
 * player finds it where the system menu puts it.
 *
 * The circle pad's rule is the crate's, not this file's: past the deadzone the
 * dominant axis wins and the other is discarded, because the world is a walk
 * grid and a diagonal push has to pick a lane. That is game policy, so it
 * lives next to the Scene; only the hardware read is here.
 */

#include "input.h"

#include <3ds.h>

#include "pocketvoxel_3ds.h"

/*
 * The PSP uses 48 on a 0..255 axis centred at 128 — 37.5% of full deflection.
 * The circle pad's full deflection is about +/-154, so the same fraction is 58.
 */
#define CIRCLE_DEADZONE 58

int32_t input_buttons(void) {
  u32 held = hidKeysHeld();
  uint32_t mask = 0;
  if (held & KEY_DUP) mask |= PV3DS_BTN_UP;
  if (held & KEY_DDOWN) mask |= PV3DS_BTN_DOWN;
  if (held & KEY_DLEFT) mask |= PV3DS_BTN_LEFT;
  if (held & KEY_DRIGHT) mask |= PV3DS_BTN_RIGHT;
  if (held & KEY_A) mask |= PV3DS_BTN_A;
  if (held & KEY_B) mask |= PV3DS_BTN_B;
  if (held & KEY_START) mask |= PV3DS_BTN_START;
  if (held & KEY_SELECT) mask |= PV3DS_BTN_SELECT;

  /* pv3ds_axis_buttons takes dy SCREEN-DOWN positive (the PSP nub's
   * convention, which its rule is transcribed from); libctru reports dy
   * positive UP. */
  circlePosition pad;
  hidCircleRead(&pad);
  mask |= pv3ds_axis_buttons(pad.dx, -pad.dy, CIRCLE_DEADZONE);
  return (int32_t)mask;
}
