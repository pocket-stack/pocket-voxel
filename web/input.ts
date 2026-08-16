import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";

export type VoxelButton = keyof typeof VOX_BTN;
export type InputListener = (mask: number) => void;

export const KEY_BINDINGS: Readonly<Record<string, VoxelButton>> = {
  ArrowUp: "up",
  KeyW: "up",
  ArrowDown: "down",
  KeyS: "down",
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
  KeyZ: "a",
  KeyJ: "a",
  KeyX: "b",
  KeyK: "b",
  Escape: "b",
  Enter: "start",
  ShiftLeft: "select",
  ShiftRight: "select",
};

const GAMEPAD_PRESS = 0.5;
const GAMEPAD_RELEASE = 0.35;

/**
 * Ref-counted browser input. Each physical source owns its complete button
 * set, so releasing a touch cannot clear the same direction held on a
 * keyboard or gamepad.
 */
export class InputMux {
  private readonly bySource = new Map<string, number>();
  private readonly listeners = new Set<InputListener>();
  private current = 0;

  get mask(): number {
    return this.current;
  }

  subscribe(listener: InputListener): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  replace(source: string, mask: number): void {
    const clean = mask & 0xff;
    if (clean === 0) this.bySource.delete(source);
    else this.bySource.set(source, clean);
    this.recompute();
  }

  set(source: string, button: VoxelButton, down: boolean): void {
    const bit = VOX_BTN[button];
    const was = this.bySource.get(source) ?? 0;
    this.replace(source, down ? was | bit : was & ~bit);
  }

  clearSource(source: string): void {
    if (!this.bySource.delete(source)) return;
    this.recompute();
  }

  clearPrefix(prefix: string): void {
    let changed = false;
    for (const source of this.bySource.keys()) {
      if (source.startsWith(prefix)) {
        this.bySource.delete(source);
        changed = true;
      }
    }
    if (changed) this.recompute();
  }

  clear(): void {
    if (this.bySource.size === 0 && this.current === 0) return;
    this.bySource.clear();
    this.recompute();
  }

  private recompute(): void {
    let next = 0;
    for (const mask of this.bySource.values()) next |= mask;
    if (next === this.current) return;
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }
}

function axisDown(value: number, direction: -1 | 1, wasDown: boolean): boolean {
  const projected = value * direction;
  return projected >= (wasDown ? GAMEPAD_RELEASE : GAMEPAD_PRESS);
}

function pressed(button: GamepadButton | undefined): boolean {
  return button?.pressed === true || (button?.value ?? 0) >= GAMEPAD_PRESS;
}

/** Standard Gamepad mapping with hysteresis on the left stick. */
export function standardGamepadMask(pad: Gamepad, previous = 0): number {
  let mask = 0;
  const had = (button: VoxelButton) => (previous & VOX_BTN[button]) !== 0;
  const axisX = pad.axes[0] ?? 0;
  const axisY = pad.axes[1] ?? 0;
  if (pressed(pad.buttons[12]) || axisDown(axisY, -1, had("up"))) mask |= VOX_BTN.up;
  if (pressed(pad.buttons[13]) || axisDown(axisY, 1, had("down"))) mask |= VOX_BTN.down;
  if (pressed(pad.buttons[14]) || axisDown(axisX, -1, had("left"))) mask |= VOX_BTN.left;
  if (pressed(pad.buttons[15]) || axisDown(axisX, 1, had("right"))) mask |= VOX_BTN.right;
  if (pressed(pad.buttons[0])) mask |= VOX_BTN.a;
  if (pressed(pad.buttons[1])) mask |= VOX_BTN.b;
  if (pressed(pad.buttons[9])) mask |= VOX_BTN.start;
  if (pressed(pad.buttons[8])) mask |= VOX_BTN.select;
  return mask;
}

export function attachKeyboard(target: HTMLElement, mux: InputMux): () => void {
  const onKey = (down: boolean) => (event: KeyboardEvent) => {
    const button = KEY_BINDINGS[event.code];
    if (!button) return;
    event.preventDefault();
    mux.set(`key:${event.code}`, button, down);
  };
  const keydown = onKey(true);
  const keyup = onKey(false);
  const blur = () => mux.clearPrefix("key:");
  target.addEventListener("keydown", keydown);
  target.addEventListener("keyup", keyup);
  target.addEventListener("blur", blur);
  return () => {
    target.removeEventListener("keydown", keydown);
    target.removeEventListener("keyup", keyup);
    target.removeEventListener("blur", blur);
    mux.clearPrefix("key:");
  };
}

function buttonAtPoint(x: number, y: number): VoxelButton | null {
  const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-voxel-button]");
  const button = element?.dataset.voxelButton as VoxelButton | undefined;
  return button && button in VOX_BTN ? button : null;
}

export function attachPointerControls(root: HTMLElement, mux: InputMux): () => void {
  const active = new Map<number, VoxelButton>();
  const setPointer = (event: PointerEvent, button: VoxelButton | null) => {
    const source = `pointer:${event.pointerId}`;
    active.delete(event.pointerId);
    if (button) {
      active.set(event.pointerId, button);
      mux.replace(source, VOX_BTN[button]);
    } else {
      mux.clearSource(source);
    }
  };
  const down = (event: PointerEvent) => {
    const target = (event.target as Element | null)?.closest<HTMLElement>("[data-voxel-button]");
    const button = target?.dataset.voxelButton as VoxelButton | undefined;
    if (!button || !(button in VOX_BTN)) return;
    event.preventDefault();
    root.setPointerCapture(event.pointerId);
    setPointer(event, button);
  };
  const move = (event: PointerEvent) => {
    if (!active.has(event.pointerId)) return;
    event.preventDefault();
    setPointer(event, buttonAtPoint(event.clientX, event.clientY));
  };
  const release = (event: PointerEvent) => {
    if (!active.has(event.pointerId)) return;
    event.preventDefault();
    setPointer(event, null);
  };
  root.addEventListener("pointerdown", down);
  root.addEventListener("pointermove", move);
  root.addEventListener("pointerup", release);
  root.addEventListener("pointercancel", release);
  root.addEventListener("lostpointercapture", release);
  return () => {
    root.removeEventListener("pointerdown", down);
    root.removeEventListener("pointermove", move);
    root.removeEventListener("pointerup", release);
    root.removeEventListener("pointercancel", release);
    root.removeEventListener("lostpointercapture", release);
    for (const pointerId of active.keys()) mux.clearSource(`pointer:${pointerId}`);
    active.clear();
  };
}

export class GamepadPoller {
  private readonly previous = new Map<number, number>();

  constructor(private readonly mux: InputMux) {}

  poll(pads: readonly (Gamepad | null)[] = navigator.getGamepads()): boolean {
    const seen = new Set<number>();
    let connected = false;
    for (const pad of pads) {
      if (!pad) continue;
      connected = true;
      seen.add(pad.index);
      const mask = standardGamepadMask(pad, this.previous.get(pad.index) ?? 0);
      this.previous.set(pad.index, mask);
      this.mux.replace(`gamepad:${pad.index}`, mask);
    }
    for (const index of this.previous.keys()) {
      if (!seen.has(index)) {
        this.previous.delete(index);
        this.mux.clearSource(`gamepad:${index}`);
      }
    }
    return connected;
  }

  clear(): void {
    this.previous.clear();
    this.mux.clearPrefix("gamepad:");
  }
}
