// Two-level edge-per-step input. Ports gen1recomp src/core/Input.lua:
// `state` = held this frame, `pressed` = edge, valid for the current fixed
// step only; step() promotes queued presses to edges once per step.
//
// Sources model the Lua's multi-source refcounting (Input.lua:109-135):
// several physical inputs can claim one GB button, and releasing one must
// not clear a hold another still owns. The host/tape drives buttons through
// one "host" source per button (setButtons), which is exactly how the
// reference tests inject input (tests/drivers/util.lua tap/hold writing
// pressQueue + state, Input.lua:161-166).

import { VOX_BTN } from "../../contracts/spec/voxel-spec.ts";

export type Button = keyof typeof VOX_BTN;

export const BUTTONS = Object.keys(VOX_BTN) as Button[];

export class Input {
  state: Partial<Record<Button, boolean>> = {};
  pressed: Partial<Record<Button, boolean>> = {};
  pressQueue: Button[] = [];
  sources: Partial<Record<Button, Set<string>>> = {};
  private lastMask = 0;

  // Input.lua:95 reset — wipe held state (focus loss / fresh boot).
  reset(): void {
    this.state = {};
    this.pressed = {};
    this.pressQueue = [];
    this.sources = {};
    this.lastMask = 0;
  }

  // Input.lua:109 press — a source claims the button; only a NEW claim
  // queues an edge, so key-repeat can never double-press.
  sourcePress(btn: Button, source: string): void {
    let sources = this.sources[btn];
    if (!sources) {
      sources = new Set();
      this.sources[btn] = sources;
    }
    if (!sources.has(source)) {
      sources.add(source);
      this.pressQueue.push(btn);
    }
    this.state[btn] = true;
  }

  // Input.lua:122 release — the hold clears only when the LAST source lets
  // go; the emptied set (not deleted) lets step() tell a real
  // press-then-release from a synthetic inject that never had sources.
  sourceRelease(btn: Button, source: string): void {
    const sources = this.sources[btn];
    if (sources) {
      sources.delete(source);
      if (sources.size === 0) {
        this.state[btn] = false;
      }
    } else {
      this.state[btn] = false;
    }
  }

  // Synthetic pressQueue inject with no source entry — the tests/drivers
  // path (Input.lua:161-166): the queued edge also asserts state in step().
  injectPress(btn: Button): void {
    this.pressQueue.push(btn);
  }

  // Host tick mask -> per-source press/release. A bit newly set this tick
  // queues an edge; a bit still set holds; a bit cleared releases. A
  // one-tick tape `press` is therefore an edge on that tick and a release
  // on the next — the same shape as util.lua's tap().
  setButtons(mask: number): void {
    for (const btn of BUTTONS) {
      const bit = VOX_BTN[btn];
      const now = (mask & bit) !== 0;
      const was = (this.lastMask & bit) !== 0;
      if (now && !was) this.sourcePress(btn, "host");
      else if (!now && was) this.sourceRelease(btn, "host");
    }
    this.lastMask = mask;
  }

  // Input.lua:157 step — promote queued presses to this step's edges. Hold
  // state is owned by live sources; a press fully released before this step
  // (sources drained to an empty set) keeps its edge but stays up.
  step(): void {
    this.pressed = {};
    for (const btn of this.pressQueue) {
      this.pressed[btn] = true;
      const sources = this.sources[btn];
      if (sources === undefined) {
        // synthetic pressQueue inject: no live source map
        this.state[btn] = true;
      } else if (sources.size > 0) {
        this.state[btn] = true;
      }
      // sources.size === 0: real press fully released before this step — keep up
    }
    for (const btn of Object.keys(this.sources) as Button[]) {
      if (this.sources[btn]!.size === 0) {
        delete this.sources[btn];
      }
    }
    this.pressQueue = [];
  }

  // Input.lua:369
  isDown(btn: Button): boolean {
    return this.state[btn] === true;
  }

  // Input.lua:382 — true only during the step the press edged into.
  wasPressed(btn: Button): boolean {
    return this.pressed[btn] === true;
  }
}
