import { QUALITY_TIER, VOX_OP } from "../contracts/spec/voxel-spec.ts";
import { fromObject } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import type { VoxelHost } from "../voxelmon/game/host.ts";
import type { BrowserAudio } from "./audio.ts";
import { FixedClock } from "./clock.ts";
import { GamepadPoller, InputMux } from "./input.ts";

const AUDIO_RATE = 44100;

interface PocketVoxelCore {
  op(code: number, argc: number, ...args: number[]): boolean;
  op_text(code: number, x: number, y: number, text: string): void;
  quality(tier: number): boolean;
  tick(): void;
  render(): number;
  framebuffer_ptr(): number;
  framebuffer_len(): number;
  width(): number;
  height(): number;
  gamedata_ptr(): number;
  gamedata_len(): number;
  audiodata_ptr(): number;
  audiodata_len(): number;
  set_audio_rate(rate: number): boolean;
  audio_rate(): number;
  render_audio(frames: number): number;
  pcm_ptr(): number;
  pcm_len(): number;
  stats(): Uint32Array;
  free?(): void;
}

interface WasmGlue {
  default(input?: { module_or_path: URL | RequestInfo | WebAssembly.Module }): Promise<unknown>;
  PocketVoxel: new (pak: Uint8Array) => PocketVoxelCore;
  wasm_memory(): WebAssembly.Memory;
}

class WasmVoxelHost implements VoxelHost {
  constructor(
    private readonly core: PocketVoxelCore,
    private audioData: ArrayBuffer | null,
  ) {}

  private call(code: number, ...args: number[]): void {
    const padded = [...args, 0, 0, 0, 0, 0, 0, 0];
    const accepted = this.core.op(
      code,
      args.length,
      padded[0],
      padded[1],
      padded[2],
      padded[3],
      padded[4],
      padded[5],
      padded[6],
    );
    if (!accepted) throw new Error(`The WASM surface rejected voxel op ${code}.`);
  }

  gamedata(): ArrayBuffer | null { return null; }
  audiodata(): ArrayBuffer | null {
    // AudioDirector parses the JSON half synchronously during boot. Hand the
    // one cold copy over instead of retaining another AUDI/programs blob for
    // the lifetime of the player.
    const data = this.audioData;
    this.audioData = null;
    return data;
  }
  stats(): ArrayBuffer | null { return this.core.stats().slice().buffer as ArrayBuffer; }
  reset(): void { this.call(VOX_OP.reset); }
  mapShow(slot: number, mapId: number, ox: number, oy: number): void {
    this.call(VOX_OP.mapShow, slot, mapId, ox, oy);
  }
  mapHide(slot: number): void { this.call(VOX_OP.mapHide, slot); }
  cam(x: number, y: number): void { this.call(VOX_OP.cam, x, y); }
  pitch(rung: number): void { this.call(VOX_OP.pitch, rung); }
  tint(abgr: number): void { this.call(VOX_OP.tint, abgr); }
  sky(on: number): void { this.call(VOX_OP.sky, on); }
  stamp(mapId: number, cx: number, cy: number, on: number): void {
    this.call(VOX_OP.stamp, mapId, cx, cy, on);
  }
  palette(index: number): void { this.call(VOX_OP.palette, index); }
  ent(slot: number, sheet: number, frame: number, x: number, y: number, lift: number, flags: number): void {
    this.call(VOX_OP.ent, slot, sheet, frame, x, y, lift, flags);
  }
  entHide(slot: number): void { this.call(VOX_OP.entHide, slot); }
  emote(slot: number, kind: number): void { this.call(VOX_OP.emote, slot, kind); }
  uiTile(x: number, y: number, tile: number): void { this.call(VOX_OP.uiTile, x, y, tile); }
  uiFill(x: number, y: number, w: number, h: number, tile: number): void {
    this.call(VOX_OP.uiFill, x, y, w, h, tile);
  }
  uiText(x: number, y: number, str: string): void { this.core.op_text(VOX_OP.uiText, x, y, str); }
  uiReveal(n: number): void { this.call(VOX_OP.uiReveal, n); }
  uiClear(): void { this.call(VOX_OP.uiClear); }
  arena(mapId: number, x: number, y: number, shape: number, rig: number): void {
    this.call(VOX_OP.arena, mapId, x, y, shape, rig);
  }
  card(side: number, pic: number, x: number, y: number): void {
    this.call(VOX_OP.card, side, pic, x, y);
  }
  cardHide(side: number): void { this.call(VOX_OP.cardHide, side); }
  battleCam(orbit: number, pitch: number, zoom: number): void {
    this.call(VOX_OP.battleCam, orbit, pitch, zoom);
  }
  arenaEnd(): void { this.call(VOX_OP.arenaEnd); }
  music(bank: number, addr: number, engine: number, flags: number): void {
    this.call(VOX_OP.music, bank, addr, engine, flags);
  }
  musicStop(): void { this.call(VOX_OP.musicStop); }
  musicFade(ticks: number): void { this.call(VOX_OP.musicFade, ticks); }
  sfx(bank: number, addr: number, engine: number, pitch: number, tempo: number, flags: number): void {
    this.call(VOX_OP.sfx, bank, addr, engine, pitch, tempo, flags);
  }
  cry(bank: number, addr: number, engine: number, pitch: number, length: number): void {
    this.call(VOX_OP.cry, bank, addr, engine, pitch, length);
  }
  audioWaves(engine: number, bank: number, addr: number): void {
    this.call(VOX_OP.audioWaves, engine, bank, addr);
  }
  audioDrum(engine: number, drum: number, bank: number, addr: number): void {
    this.call(VOX_OP.audioDrum, engine, drum, bank, addr);
  }
  frameDone(_tick: number, _buttons: number): void {}
}

function copySection(memory: WebAssembly.Memory, ptr: number, len: number): ArrayBuffer | null {
  if (!ptr || !len) return null;
  return new Uint8Array(memory.buffer, ptr, len).slice().buffer;
}

export interface RuntimeOptions {
  canvas: HTMLCanvasElement;
  pak: ArrayBuffer;
  gameJson: ArrayBuffer;
  input: InputMux;
  audio: BrowserAudio;
  renderHz?: 30 | 60;
  onFps?: (fps: number) => void;
  onGamepad?: (connected: boolean) => void;
  onBlit?: (canvas: HTMLCanvasElement) => void;
  onError?: (error: Error) => void;
}

export class WebRuntime {
  private constructor(
    private readonly core: PocketVoxelCore,
    private readonly memory: WebAssembly.Memory,
    private readonly game: VoxelmonGame,
    private readonly canvas: HTMLCanvasElement,
    private readonly input: InputMux,
    private readonly audio: BrowserAudio,
    private readonly onFps?: (fps: number) => void,
    private readonly onGamepad?: (connected: boolean) => void,
    private readonly onBlit?: (canvas: HTMLCanvasElement) => void,
    private readonly onError?: (error: Error) => void,
    renderHz: 30 | 60 = 60,
  ) {
    this.clock = new FixedClock(60, renderHz);
    this.gamepads = new GamepadPoller(input);
    this.context = canvas.getContext("2d", { alpha: false });
  }

  private readonly clock: FixedClock;
  private readonly gamepads: GamepadPoller;
  private raf = 0;
  private audioTick = 0;
  private frames = 0;
  private fpsStarted = 0;
  private stopped = false;
  private freed = false;
  private readonly context: CanvasRenderingContext2D | null;
  private imageData: ImageData | null = null;

  static async create(options: RuntimeOptions): Promise<WebRuntime> {
    const glueUrl = new URL("./generated/pocketvoxel_wasm.js", import.meta.url).href;
    const wasmUrl = new URL("./generated/pocketvoxel_wasm_bg.wasm", import.meta.url);
    const glue = (await import(glueUrl)) as WasmGlue;
    await glue.default({ module_or_path: wasmUrl });
    const memory = glue.wasm_memory();
    let core: PocketVoxelCore | null = null;
    try {
      core = new glue.PocketVoxel(new Uint8Array(options.pak));
      if (!core.quality(QUALITY_TIER.desktop)) throw new Error("WASM does not support desktop quality.");
      if (!core.set_audio_rate(AUDIO_RATE)) throw new Error("WASM rejected the 44.1 kHz audio rate.");
      const audioData = copySection(memory, core.audiodata_ptr(), core.audiodata_len());
      const host = new WasmVoxelHost(core, audioData);
      const source = JSON.parse(new TextDecoder().decode(options.gameJson)) as Record<string, unknown>;
      const game = new VoxelmonGame(fromObject(source), host, 17);
      if (audioData) game.setAudioFromPak();
      else game.setAudio(null);
      game.newGame();
      return new WebRuntime(
        core,
        memory,
        game,
        options.canvas,
        options.input,
        options.audio,
        options.onFps,
        options.onGamepad,
        options.onBlit,
        options.onError,
        options.renderHz,
      );
    } catch (error) {
      core?.free?.();
      throw error;
    }
  }

  setRenderHz(hz: 30 | 60): void { this.clock.setRenderHz(hz); }

  start(): void {
    if (this.freed) throw new Error("This Pocket Voxel runtime has already been closed.");
    if (!this.context) throw new Error("This browser could not create a 2D canvas context.");
    this.stopped = false;
    this.canvas.width = this.core.width();
    this.canvas.height = this.core.height();
    this.context.imageSmoothingEnabled = false;
    this.imageData = this.context.createImageData(this.core.width(), this.core.height());
    this.clock.reset(performance.now());
    this.game.tick(0);
    this.finishTick();
    this.draw();
    this.fpsStarted = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (this.stopped) return;
    this.gamepads.clear();
    this.input.clear();
    this.dispose();
  }

  /** Release a never-started stale boot without touching another runtime's shared inputs. */
  dispose(): void {
    if (this.freed) return;
    this.stopped = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.core.free?.();
    this.freed = true;
  }

  pause(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.input.clear();
  }

  resume(): void {
    if (this.stopped || this.raf) return;
    this.clock.reset(performance.now());
    this.raf = requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number) => {
    this.raf = 0;
    try {
      const connected = this.gamepads.poll();
      this.onGamepad?.(connected);
      const frame = this.clock.frame(now);
      for (let i = 0; i < frame.steps; i++) {
        this.game.tick(this.input.mask);
        this.finishTick();
      }
      if (frame.render) {
        this.draw();
        this.frames += 1;
      }
      if (now - this.fpsStarted >= 1000) {
        this.onFps?.(Math.round((this.frames * 1000) / (now - this.fpsStarted)));
        this.frames = 0;
        this.fpsStarted = now;
      }
      if (!this.stopped) this.raf = requestAnimationFrame(this.frame);
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.stop();
    }
  };

  private finishTick(): void {
    const frames =
      Math.floor(((this.audioTick + 1) * AUDIO_RATE) / 60) -
      Math.floor((this.audioTick * AUDIO_RATE) / 60);
    // Keep the chip synth clock moving even when Web Audio is unavailable or
    // muted. BrowserAudio decides whether the resulting buffer is consumed.
    if (this.core.render_audio(frames)) {
      const ptr = this.core.pcm_ptr();
      const len = this.core.pcm_len();
      if (this.audio.available && ptr && len) {
        this.audio.push(new Int16Array(this.memory.buffer, ptr, len).slice(), this.core.audio_rate());
      }
    }
    this.audioTick += 1;
    this.core.tick();
  }

  private draw(): void {
    if (!this.context || !this.imageData) return;
    this.core.render();
    const ptr = this.core.framebuffer_ptr();
    const len = this.core.framebuffer_len();
    if (!ptr || len !== this.imageData.data.length) {
      throw new Error(`WASM returned an invalid framebuffer (${len} bytes).`);
    }
    this.imageData.data.set(new Uint8ClampedArray(this.memory.buffer, ptr, len));
    this.context.putImageData(this.imageData, 0, 0);
    this.onBlit?.(this.canvas);
  }
}
