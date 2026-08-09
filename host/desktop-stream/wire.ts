// PKNT framing distilled from pocket-youtube's MIT-licensed host/wire.ts.

import {
  STREAM_ARING_MAGIC,
  STREAM_ARING_OFF,
  STREAM_HEADER_BLOCK_SIZE,
  STREAM_MAGIC,
  STREAM_VERSION,
  STREAM_VRING_MAGIC,
  STREAM_VRING_OFF,
  WIRE_BEACON_MAGIC,
  WIRE_HEADER_SIZE,
  WIRE_MAGIC,
  WIRE_MAX_PAYLOAD,
  WIRE_MSG,
  WIRE_VERSION,
} from "../../vendor/pocketjs/contracts/spec/spec.ts";
import {
  createDesktopSessionEpoch,
  desktopSlotSize,
  type DesktopStreamGeometry,
} from "./pkst.ts";

export { WIRE_MSG };

export interface WireFrame {
  kind: number;
  flags: number;
  payload: Uint8Array;
}

export function encodeFrame(kind: number, flags: number, payload: Uint8Array): Uint8Array {
  if (payload.length > WIRE_MAX_PAYLOAD) {
    throw new Error(`desktop stream: PKNT payload ${payload.length} exceeds ${WIRE_MAX_PAYLOAD}`);
  }
  const out = new Uint8Array(WIRE_HEADER_SIZE + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, kind);
  dv.setUint8(1, flags);
  dv.setUint32(4, payload.length, true);
  out.set(payload, WIRE_HEADER_SIZE);
  return out;
}

export function drainFrames(buf: Uint8Array): { frames: WireFrame[]; rest: Uint8Array } {
  const frames: WireFrame[] = [];
  let offset = 0;
  while (buf.length - offset >= WIRE_HEADER_SIZE) {
    const dv = new DataView(buf.buffer, buf.byteOffset + offset);
    const length = dv.getUint32(4, true);
    if (length > WIRE_MAX_PAYLOAD) throw new Error("desktop stream: oversize PKNT frame");
    if (buf.length - offset < WIRE_HEADER_SIZE + length) break;
    frames.push({
      kind: dv.getUint8(0),
      flags: dv.getUint8(1),
      payload: buf.slice(offset + WIRE_HEADER_SIZE, offset + WIRE_HEADER_SIZE + length),
    });
    offset += WIRE_HEADER_SIZE + length;
  }
  return { frames, rest: buf.slice(offset) };
}

export function parseHello(buf: Uint8Array): { app: string; consumed: number } | null | "bad" {
  if (buf.length < 7) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset);
  if (dv.getUint32(0, true) !== WIRE_MAGIC || dv.getUint8(4) !== WIRE_VERSION) return "bad";
  const appLength = dv.getUint8(6);
  if (appLength === 0 || appLength > 64) return "bad";
  if (buf.length < 7 + appLength) return null;
  return {
    app: new TextDecoder().decode(buf.slice(7, 7 + appLength)),
    consumed: 7 + appLength,
  };
}

export function encodeHelloAck(): Uint8Array {
  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, WIRE_MAGIC, true);
  dv.setUint8(4, WIRE_VERSION);
  return out;
}

export function encodePathPayload(path: string, body: Uint8Array): Uint8Array {
  const pathBytes = new TextEncoder().encode(path);
  const out = new Uint8Array(2 + pathBytes.length + body.length);
  new DataView(out.buffer).setUint16(0, pathBytes.length, true);
  out.set(pathBytes, 2);
  out.set(body, 2 + pathBytes.length);
  return out;
}

/** A fresh live stream header. Per-connection sequence numbers start at zero. */
export function headerBlock(
  geometry: DesktopStreamGeometry,
  epoch = createDesktopSessionEpoch(),
): Uint8Array {
  if (!Number.isInteger(epoch) || epoch <= 0 || epoch > 0xffff_ffff) {
    throw new Error("desktop stream: session epoch must be a non-zero u32");
  }
  const block = new Uint8Array(STREAM_HEADER_BLOCK_SIZE);
  const dv = new DataView(block.buffer);
  const videoOff = STREAM_HEADER_BLOCK_SIZE;
  const audioOff = videoOff + geometry.slotCount * desktopSlotSize(geometry);
  dv.setUint32(0, STREAM_MAGIC, true);
  dv.setUint16(4, STREAM_VERSION, true);
  dv.setUint32(8, epoch, true);
  dv.setUint32(12, videoOff, true);
  dv.setUint32(16, audioOff, true);
  dv.setUint32(STREAM_VRING_OFF, STREAM_VRING_MAGIC, true);
  dv.setUint16(STREAM_VRING_OFF + 4, geometry.w, true);
  dv.setUint16(STREAM_VRING_OFF + 6, geometry.h, true);
  dv.setUint16(STREAM_VRING_OFF + 8, geometry.fpsNum, true);
  dv.setUint16(STREAM_VRING_OFF + 10, geometry.fpsDen, true);
  dv.setUint32(STREAM_VRING_OFF + 12, geometry.slotCount, true);
  dv.setUint32(STREAM_VRING_OFF + 16, desktopSlotSize(geometry), true);
  dv.setUint32(STREAM_VRING_OFF + 24, 0, true);
  dv.setUint32(STREAM_ARING_OFF, STREAM_ARING_MAGIC, true);
  dv.setUint32(STREAM_ARING_OFF + 4, geometry.sampleRate, true);
  dv.setUint16(STREAM_ARING_OFF + 8, geometry.channels, true);
  dv.setUint32(STREAM_ARING_OFF + 12, geometry.chunkFrames, true);
  dv.setUint32(STREAM_ARING_OFF + 16, geometry.chunkCount, true);
  return block;
}

export function encodeVideoSlot(
  seq: number,
  frameIndex: number,
  width: number,
  height: number,
  palette: Uint8Array,
  indices: Uint8Array,
  rle: boolean,
): Uint8Array {
  const out = new Uint8Array(16 + 1024 + indices.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, seq, true);
  dv.setUint32(4, frameIndex, true);
  dv.setUint16(8, width, true);
  dv.setUint16(10, height, true);
  dv.setUint16(12, rle ? 1 : 0, true);
  out.set(palette, 16);
  out.set(indices, 16 + 1024);
  return out;
}

export function encodeBeacon(tcpPort: number, app: string, name: string): Uint8Array {
  const appBytes = new TextEncoder().encode(app);
  const nameBytes = new TextEncoder().encode(name.slice(0, 32));
  const out = new Uint8Array(10 + appBytes.length + nameBytes.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, WIRE_BEACON_MAGIC, true);
  dv.setUint8(4, WIRE_VERSION);
  dv.setUint16(6, tcpPort, true);
  dv.setUint8(8, appBytes.length);
  out.set(appBytes, 9);
  dv.setUint8(9 + appBytes.length, nameBytes.length);
  out.set(nameBytes, 10 + appBytes.length);
  return out;
}
