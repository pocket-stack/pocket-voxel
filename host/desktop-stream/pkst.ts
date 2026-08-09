// Live desktop frames use PocketJS's PKST byte contract, distilled from
// pocket-youtube's MIT-licensed host/ring.ts. The file is a fixed-size video
// ring: a frame slot is written completely before latestSeq publishes it.

import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  STREAM_ARING_MAGIC,
  STREAM_ARING_OFF,
  STREAM_CHUNK_HEADER_SIZE,
  STREAM_FLAG_ENDED,
  STREAM_HEADER_BLOCK_SIZE,
  STREAM_MAGIC,
  STREAM_SLOT_HEADER_SIZE,
  STREAM_VERSION,
  STREAM_VRING_MAGIC,
  STREAM_VRING_OFF,
  TEX_MAX_DIM,
} from "../../vendor/pocketjs/contracts/spec/spec.ts";

export interface DesktopStreamGeometry {
  w: number;
  h: number;
  fpsNum: number;
  fpsDen: number;
  slotCount: number;
  sampleRate: number;
  channels: 1 | 2;
  chunkFrames: number;
  chunkCount: number;
  /** Zero means a live stream with no known end. */
  totalFrames: number;
}

export const DEFAULT_DESKTOP_GEOMETRY: DesktopStreamGeometry = {
  // This is pocket-youtube's real-PSP bandwidth rung. The pixels are
  // pre-squashed for the 2:1, 360x180 window and stretched on-device.
  w: 512,
  h: 128,
  fpsNum: 12,
  fpsDen: 1,
  slotCount: 8,
  // PKST v1 always carries a valid audio descriptor. Desktop capture does not
  // publish audio chunks, so this deliberately tiny ring remains at seq 0.
  sampleRate: 4_000,
  channels: 1,
  chunkFrames: 1,
  chunkCount: 2,
  totalFrames: 0,
};

const align16 = (n: number): number => (n + 15) & ~15;
const pow2 = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

export const desktopSlotSize = (g: DesktopStreamGeometry): number =>
  align16(STREAM_SLOT_HEADER_SIZE + 1024 + g.w * g.h);

export const desktopChunkSize = (g: DesktopStreamGeometry): number =>
  STREAM_CHUNK_HEADER_SIZE + g.chunkFrames * g.channels * 2;

export const desktopStreamSize = (g: DesktopStreamGeometry): number => {
  const audioOff = STREAM_HEADER_BLOCK_SIZE + g.slotCount * desktopSlotSize(g);
  return audioOff + g.chunkCount * desktopChunkSize(g);
};

/** A new daemon session must not look like the previous contents of the fixed path. */
export function createDesktopSessionEpoch(): number {
  return randomBytes(4).readUInt32LE(0) || 1;
}

export interface DesktopStreamWriterOptions {
  /** Test seam; production sessions generate a fresh non-zero u32. */
  epoch?: number;
}

export class DesktopStreamWriter {
  readonly geometry: DesktopStreamGeometry;
  readonly epoch: number;
  readonly slotSize: number;
  readonly videoOff = STREAM_HEADER_BLOCK_SIZE;
  readonly audioOff: number;
  private readonly fd: number;
  private readonly path: string;
  private videoSeq = 0;
  private ended = false;
  private closed = false;

  constructor(
    path: string,
    geometry: DesktopStreamGeometry = DEFAULT_DESKTOP_GEOMETRY,
    options: DesktopStreamWriterOptions = {},
  ) {
    if (
      !pow2(geometry.w) ||
      !pow2(geometry.h) ||
      geometry.w > TEX_MAX_DIM ||
      geometry.h > TEX_MAX_DIM
    ) {
      throw new Error(
        `desktop stream: dimensions must be powers of two <= ${TEX_MAX_DIM}, got ${geometry.w}x${geometry.h}`,
      );
    }
    if (geometry.fpsNum <= 0 || geometry.fpsDen <= 0) {
      throw new Error("desktop stream: frame rate must be positive");
    }
    if (geometry.slotCount < 2 || geometry.chunkCount < 2) {
      throw new Error("desktop stream: PKST rings need at least two entries");
    }
    const epoch = options.epoch ?? createDesktopSessionEpoch();
    if (!Number.isInteger(epoch) || epoch <= 0 || epoch > 0xffff_ffff) {
      throw new Error("desktop stream: session epoch must be a non-zero u32");
    }

    this.geometry = { ...geometry };
    this.epoch = epoch;
    this.slotSize = desktopSlotSize(geometry);
    this.audioOff = this.videoOff + geometry.slotCount * this.slotSize;
    this.path = path;
    this.fd = openSync(path, "w+");

    // Preallocate every slot. A device-side positional read treats a short
    // read as transport failure, not as a live-stream EOF.
    const size = desktopStreamSize(geometry);
    writeSync(this.fd, new Uint8Array(size), 0, size, 0);
    this.writeHeader();
  }

  private writeHeader(): void {
    const g = this.geometry;
    const block = new Uint8Array(STREAM_HEADER_BLOCK_SIZE);
    const dv = new DataView(block.buffer);
    dv.setUint32(0, STREAM_MAGIC, true);
    dv.setUint16(4, STREAM_VERSION, true);
    dv.setUint16(6, this.ended ? STREAM_FLAG_ENDED : 0, true);
    dv.setUint32(8, this.epoch, true);
    dv.setUint32(12, this.videoOff, true);
    dv.setUint32(16, this.audioOff, true);

    dv.setUint32(STREAM_VRING_OFF, STREAM_VRING_MAGIC, true);
    dv.setUint16(STREAM_VRING_OFF + 4, g.w, true);
    dv.setUint16(STREAM_VRING_OFF + 6, g.h, true);
    dv.setUint16(STREAM_VRING_OFF + 8, g.fpsNum, true);
    dv.setUint16(STREAM_VRING_OFF + 10, g.fpsDen, true);
    dv.setUint32(STREAM_VRING_OFF + 12, g.slotCount, true);
    dv.setUint32(STREAM_VRING_OFF + 16, this.slotSize, true);
    dv.setUint32(STREAM_VRING_OFF + 20, this.videoSeq, true);
    dv.setUint32(STREAM_VRING_OFF + 24, g.totalFrames, true);

    dv.setUint32(STREAM_ARING_OFF, STREAM_ARING_MAGIC, true);
    dv.setUint32(STREAM_ARING_OFF + 4, g.sampleRate, true);
    dv.setUint16(STREAM_ARING_OFF + 8, g.channels, true);
    dv.setUint32(STREAM_ARING_OFF + 12, g.chunkFrames, true);
    dv.setUint32(STREAM_ARING_OFF + 16, g.chunkCount, true);
    dv.setUint32(STREAM_ARING_OFF + 20, 0, true); // no captured audio
    writeSync(this.fd, block, 0, block.length, 0);
  }

  private patchU32(offset: number, value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    writeSync(this.fd, bytes, 0, bytes.length, offset);
  }

  /** Write payload first, then publish latestSeq. */
  writeFrame(frameIndex: number, palette: Uint8Array, indices: Uint8Array): number {
    if (this.closed) throw new Error("desktop stream: writer is closed");
    const g = this.geometry;
    if (palette.length !== 1024 || indices.length !== g.w * g.h) {
      throw new Error("desktop stream: CLUT8 frame has the wrong size");
    }

    const seq = ++this.videoSeq;
    const slot = new Uint8Array(this.slotSize);
    const dv = new DataView(slot.buffer);
    dv.setUint32(0, seq, true);
    dv.setUint32(4, frameIndex, true);
    dv.setUint16(8, g.w, true);
    dv.setUint16(10, g.h, true);
    slot.set(palette, STREAM_SLOT_HEADER_SIZE);
    slot.set(indices, STREAM_SLOT_HEADER_SIZE + 1024);
    const offset = this.videoOff + ((seq - 1) % g.slotCount) * this.slotSize;
    writeSync(this.fd, slot, 0, slot.length, offset);
    this.patchU32(STREAM_VRING_OFF + 20, seq);
    return seq;
  }

  markEnded(): void {
    if (this.closed || this.ended) return;
    this.ended = true;
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, STREAM_FLAG_ENDED, true);
    writeSync(this.fd, bytes, 0, bytes.length, 6);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.fd);
    } finally {
      // A desktop ring contains screenshots. Open Unix file descriptors keep
      // their final bytes long enough to observe ENDED, but the path must not
      // leave the last eight frames behind after the daemon exits.
      try {
        unlinkSync(this.path);
      } catch {
        // Already removed is the desired state.
      }
    }
  }
}
