export interface ClockFrame {
  steps: number;
  render: boolean;
}

/** Fixed 60 Hz logic with a separately selectable 30/60 Hz presentation. */
export class FixedClock {
  private last = 0;
  private accumulator = 0;
  private tick = 0;

  constructor(
    readonly logicHz = 60,
    private renderHz: 30 | 60 = 60,
    readonly maxCatchUp = 4,
  ) {}

  setRenderHz(hz: 30 | 60): void {
    this.renderHz = hz;
  }

  reset(now = 0): void {
    this.last = now;
    this.accumulator = 0;
  }

  frame(now: number): ClockFrame {
    if (this.last === 0) {
      this.last = now;
      return { steps: 0, render: false };
    }
    const elapsed = Math.max(0, Math.min(250, now - this.last));
    this.last = now;
    this.accumulator += elapsed;
    const stepMs = 1000 / this.logicHz;
    let steps = 0;
    let render = false;
    const renderEvery = this.logicHz / this.renderHz;
    while (this.accumulator >= stepMs && steps < this.maxCatchUp) {
      this.accumulator -= stepMs;
      this.tick += 1;
      steps += 1;
      if (this.tick % renderEvery === 0) render = true;
    }
    if (steps === this.maxCatchUp && this.accumulator >= stepMs) {
      this.accumulator %= stepMs;
    }
    return { steps, render };
  }
}
