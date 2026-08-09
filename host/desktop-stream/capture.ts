import { captureCommand } from "./avfoundation.ts";
import { RGB332_PALETTE, rgb24ToClut8 } from "./clut8.ts";
import { DesktopStreamWriter, type DesktopStreamGeometry } from "./pkst.ts";

export interface FrameSink {
  writeFrame(frameIndex: number, palette: Uint8Array, indices: Uint8Array): number | void;
}

/** Assemble arbitrary stdout chunks into exact RGB24 frames. */
export async function pumpRgb24Frames(
  stdout: ReadableStream<Uint8Array>,
  geometry: Pick<DesktopStreamGeometry, "w" | "h">,
  sink: FrameSink,
  shouldStop: () => boolean = () => false,
  onFrame?: (count: number) => void,
): Promise<number> {
  const frameBytes = geometry.w * geometry.h * 3;
  const frame = new Uint8Array(frameBytes);
  let used = 0;
  let frameIndex = 0;

  for await (const chunk of stdout) {
    let offset = 0;
    while (offset < chunk.length) {
      if (shouldStop()) return frameIndex;
      const take = Math.min(frameBytes - used, chunk.length - offset);
      frame.set(chunk.subarray(offset, offset + take), used);
      used += take;
      offset += take;
      if (used !== frameBytes) continue;

      const indices = rgb24ToClut8(frame, geometry.w, geometry.h);
      sink.writeFrame(frameIndex, RGB332_PALETTE, indices);
      frameIndex++;
      onFrame?.(frameIndex);
      used = 0;
    }
  }
  return frameIndex;
}

export interface DesktopCaptureOptions {
  ffmpeg: string;
  device: string;
  geometry: DesktopStreamGeometry;
  streamPath: string;
  onFrame?: (count: number) => void;
  /** Receives the same converted frame after it is published to the file ring. */
  onClutFrame?: (frameIndex: number, palette: Uint8Array, indices: Uint8Array) => void;
}

export interface DesktopCaptureResult {
  code: number;
  frames: number;
  stderr: string;
  stopped: boolean;
}

interface CaptureProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export class DesktopCapture {
  readonly done: Promise<DesktopCaptureResult>;
  private readonly process: CaptureProcess;
  private readonly writer: DesktopStreamWriter;
  private stopping = false;

  constructor(options: DesktopCaptureOptions) {
    this.writer = new DesktopStreamWriter(options.streamPath, options.geometry);
    try {
      this.process = Bun.spawn(
        captureCommand(
          options.ffmpeg,
          options.device,
          options.geometry.fpsNum / options.geometry.fpsDen,
          options.geometry.w,
          options.geometry.h,
        ),
        { stdout: "pipe", stderr: "pipe" },
      ) as CaptureProcess;
    } catch (error) {
      this.writer.markEnded();
      this.writer.close();
      throw error;
    }
    this.done = this.run(options);
  }

  private async run(options: DesktopCaptureOptions): Promise<DesktopCaptureResult> {
    const stderrPromise = new Response(this.process.stderr).text();
    let frames = 0;
    try {
      try {
        const sink: FrameSink = {
          writeFrame: (frameIndex, palette, indices) => {
            const seq = this.writer.writeFrame(frameIndex, palette, indices);
            options.onClutFrame?.(frameIndex, palette, indices);
            return seq;
          },
        };
        frames = await pumpRgb24Frames(
          this.process.stdout,
          options.geometry,
          sink,
          () => this.stopping,
          options.onFrame,
        );
      } catch (error) {
        try {
          this.process.kill();
        } catch {
          // The process may already have exited after closing stdout.
        }
        await Promise.allSettled([this.process.exited, stderrPromise]);
        throw error;
      }

      const [code, stderr] = await Promise.all([this.process.exited, stderrPromise]);
      return { code, frames, stderr, stopped: this.stopping };
    } finally {
      this.writer.markEnded();
      this.writer.close();
    }
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    try {
      this.process.kill();
    } catch {
      // Already exited.
    }
  }
}
