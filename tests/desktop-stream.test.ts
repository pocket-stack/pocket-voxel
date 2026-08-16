import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  STREAM_FLAG_ENDED,
  STREAM_HEADER_BLOCK_SIZE,
  STREAM_MAGIC,
  STREAM_SLOT_HEADER_SIZE,
  STREAM_VERSION,
  STREAM_VRING_OFF,
  WIRE_BEACON_MAGIC,
  WIRE_MAGIC,
  WIRE_MSG,
  WIRE_PORT,
  WIRE_VERSION,
} from "../vendor/pocketjs/contracts/spec/spec.ts";
import {
  captureCommand,
  parseCaptureScreens,
  selectCaptureScreen,
} from "../host/desktop-stream/avfoundation.ts";
import { pumpRgb24Frames } from "../host/desktop-stream/capture.ts";
import { RGB332_PALETTE, rgb24ToClut8 } from "../host/desktop-stream/clut8.ts";
import { parseDesktopStreamCli } from "../host/desktop-stream/cli.ts";
import {
  DesktopStreamWriter,
  createDesktopSessionEpoch,
  desktopSlotSize,
  desktopStreamSize,
  type DesktopStreamGeometry,
} from "../host/desktop-stream/pkst.ts";
import {
  DESKTOP_STREAM_REL_PATH,
  startDesktopTcpTransport,
} from "../host/desktop-stream/tcp.ts";
import { drainFrames, encodeBeacon, type WireFrame } from "../host/desktop-stream/wire.ts";

const temp = mkdtempSync(join(tmpdir(), "pocket-voxel-desktop-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function encodeHello(app: string): Uint8Array {
  const appBytes = new TextEncoder().encode(app);
  const hello = new Uint8Array(7 + appBytes.length);
  const dv = new DataView(hello.buffer);
  dv.setUint32(0, WIRE_MAGIC, true);
  dv.setUint8(4, WIRE_VERSION);
  dv.setUint8(6, appBytes.length);
  hello.set(appBytes, 7);
  return hello;
}

function readDesktopWire(socket: Socket): {
  ack: Promise<Uint8Array>;
  nextFrame(): Promise<WireFrame>;
} {
  let buffer: Uint8Array = new Uint8Array(0);
  let acked = false;
  let resolveAck!: (ack: Uint8Array) => void;
  let rejectAck!: (error: Error) => void;
  const ack = new Promise<Uint8Array>((resolve, reject) => {
    resolveAck = resolve;
    rejectAck = reject;
  });
  const frames: WireFrame[] = [];
  const waiters: Array<{
    resolve(frame: WireFrame): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  socket.on("data", (chunk: Buffer) => {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;
    if (!acked && buffer.length >= 8) {
      acked = true;
      resolveAck(buffer.slice(0, 8));
      buffer = buffer.slice(8);
    }
    if (!acked) return;
    try {
      const drained = drainFrames(buffer);
      buffer = drained.rest;
      for (const frame of drained.frames) {
        const waiter = waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        } else {
          frames.push(frame);
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      rejectAck(reason);
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(reason);
      }
    }
  });

  return {
    ack,
    nextFrame() {
      const frame = frames.shift();
      if (frame) return Promise.resolve(frame);
      return new Promise<WireFrame>((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error("timed out waiting for desktop PKNT frame"));
          }, 2_000),
        };
        waiters.push(waiter);
      });
    },
  };
}

test("AVFoundation listing resolves Capture screen N independently of device index", () => {
  const listing = `[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] FaceTime HD Camera
[AVFoundation indev @ 0x1] [3] Capture screen 0
[AVFoundation indev @ 0x1] [4] Capture screen 1`;
  const screens = parseCaptureScreens(listing);
  expect(screens).toEqual([
    { deviceIndex: 3, screen: 0, name: "Capture screen 0" },
    { deviceIndex: 4, screen: 1, name: "Capture screen 1" },
  ]);
  expect(selectCaptureScreen(screens, 1).deviceIndex).toBe(4);
  expect(() => selectCaptureScreen(screens, 2)).toThrow(/available: 0, 1/);
});

test("capture command is a video-only 512x128 RGB24 pipe pre-squashed for the window", () => {
  const args = captureCommand("/opt/ffmpeg", "Capture screen 0", 12, 512, 128);
  expect(args[0]).toBe("/opt/ffmpeg");
  expect(args).toContain("avfoundation");
  expect(args).toContain("Capture screen 0:none");
  expect(args).toContain("rgb24");
  expect(args).toContain("-an");
  expect(args.slice(args.indexOf("-i") - 2, args.indexOf("-i"))).toEqual([
    "-pixel_format",
    "bgr0",
  ]);
  expect(args.join(" ")).toContain("setsar=2/1");
  expect(args.join(" ")).toContain("fps=12");
  expect(args.join(" ")).toContain("scale=512:128");
  expect(args.join(" ")).toContain("reset_sar=1");
});

test("CLI accepts an explicit device and validates screen/fps", () => {
  const parsed = parseDesktopStreamCli([
    "--dir",
    "./memstick",
    "--device=Capture screen 2",
    "--fps",
    "20",
  ]);
  expect(parsed.dir).toBe(join(process.cwd(), "memstick"));
  expect(parsed.device).toBe("Capture screen 2");
  expect(parsed.fps).toBe(20);
  expect(parsed.tcpPort).toBeUndefined();
  expect(parseDesktopStreamCli(["--tcp"]).tcpPort).toBe(WIRE_PORT);
  expect(parseDesktopStreamCli(["--tcp", "9000"]).tcpPort).toBe(9000);
  expect(parseDesktopStreamCli(["--tcp=9001"]).tcpPort).toBe(9001);
  expect(() => parseDesktopStreamCli(["--screen=-1"])).toThrow(/non-negative/);
  expect(() => parseDesktopStreamCli(["--fps=0"])).toThrow(/1 through 60/);
  expect(() => parseDesktopStreamCli(["--tcp=0"])).toThrow(/1 through 65535/);
});

test("RGB24 conversion uses a stable opaque RGB332 palette", () => {
  const indices = rgb24ToClut8(
    new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]),
    4,
    1,
  );
  expect([...indices]).toEqual([0xe0, 0x1c, 0x03, 0xff]);
  const dv = new DataView(RGB332_PALETTE.buffer);
  expect(dv.getUint32(0xe0 * 4, true)).toBe(0xff0000ff); // opaque red, ABGR
  expect(dv.getUint32(0x03 * 4, true)).toBe(0xffff0000); // opaque blue, ABGR
});

test("RGB pump reconstructs frames split across arbitrary stdout chunks", async () => {
  const bytes = new Uint8Array([
    255, 0, 0, 0, 255, 0, // frame 0: red, green
    0, 0, 255, 255, 255, 255, // frame 1: blue, white
  ]);
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 2));
      controller.enqueue(bytes.slice(2, 9));
      controller.enqueue(bytes.slice(9));
      controller.close();
    },
  });
  const frames: { index: number; indices: number[] }[] = [];
  const count = await pumpRgb24Frames(stdout, { w: 2, h: 1 }, {
    writeFrame(index, _palette, indices) {
      frames.push({ index, indices: [...indices] });
    },
  });
  expect(count).toBe(2);
  expect(frames).toEqual([
    { index: 0, indices: [0xe0, 0x1c] },
    { index: 1, indices: [0x03, 0xff] },
  ]);
});

describe("PKST desktop ring", () => {
  const geometry: DesktopStreamGeometry = {
    w: 16,
    h: 16,
    fpsNum: 12,
    fpsDen: 1,
    slotCount: 2,
    sampleRate: 4_000,
    channels: 1,
    chunkFrames: 1,
    chunkCount: 2,
    totalFrames: 0,
  };

  test("uses a session epoch, publishes a clean end, and removes captured frames on close", () => {
    const path = join(temp, "desktop.pkst");
    const epoch = 0x1234_5678;
    const writer = new DesktopStreamWriter(path, geometry, { epoch });
    const first = new Uint8Array(geometry.w * geometry.h).fill(7);
    const second = new Uint8Array(geometry.w * geometry.h).fill(11);
    let file: Uint8Array;
    try {
      writer.writeFrame(0, RGB332_PALETTE, first);
      writer.writeFrame(1, RGB332_PALETTE, second);
      writer.markEnded();
      file = new Uint8Array(readFileSync(path));
    } finally {
      writer.close();
    }

    const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
    expect(writer.epoch).toBe(epoch);
    expect(createDesktopSessionEpoch()).toBeGreaterThan(0);
    expect(file.length).toBe(desktopStreamSize(geometry));
    expect(dv.getUint32(0, true)).toBe(STREAM_MAGIC);
    expect(dv.getUint16(4, true)).toBe(STREAM_VERSION);
    expect(dv.getUint16(6, true) & STREAM_FLAG_ENDED).toBe(STREAM_FLAG_ENDED);
    expect(dv.getUint32(8, true)).toBe(epoch);
    expect(dv.getUint16(STREAM_VRING_OFF + 4, true)).toBe(16);
    expect(dv.getUint16(STREAM_VRING_OFF + 6, true)).toBe(16);
    expect(dv.getUint32(STREAM_VRING_OFF + 20, true)).toBe(2);

    const secondSlot = STREAM_HEADER_BLOCK_SIZE + desktopSlotSize(geometry);
    expect(dv.getUint32(secondSlot, true)).toBe(2);
    expect(dv.getUint32(secondSlot + 4, true)).toBe(1);
    expect(
      file.slice(secondSlot + STREAM_SLOT_HEADER_SIZE, secondSlot + STREAM_SLOT_HEADER_SIZE + 1024),
    ).toEqual(RGB332_PALETTE);
    expect(
      file.slice(
        secondSlot + STREAM_SLOT_HEADER_SIZE + 1024,
        secondSlot + STREAM_SLOT_HEADER_SIZE + 1024 + second.length,
      ),
    ).toEqual(second);
    expect(existsSync(path)).toBe(false);
  });
});

test("PKDB beacon identifies the opt-in voxelmon TCP endpoint", () => {
  const beacon = encodeBeacon(9_000, "voxelmon", "test-mac");
  const dv = new DataView(beacon.buffer, beacon.byteOffset, beacon.byteLength);
  expect(dv.getUint32(0, true)).toBe(WIRE_BEACON_MAGIC);
  expect(dv.getUint8(4)).toBe(WIRE_VERSION);
  expect(dv.getUint16(6, true)).toBe(9_000);
  expect(new TextDecoder().decode(beacon.slice(9, 17))).toBe("voxelmon");
});

test("opt-in TCP sends a fresh streamOpen then CLUT8 video slots", async () => {
  const geometry: DesktopStreamGeometry = {
    w: 16,
    h: 16,
    fpsNum: 12,
    fpsDen: 1,
    slotCount: 2,
    sampleRate: 4_000,
    channels: 1,
    chunkFrames: 1,
    chunkCount: 2,
    totalFrames: 0,
  };
  const epoch = 0x7654_3210;
  const transport = startDesktopTcpTransport({ port: 0, app: "voxelmon", geometry, epoch });
  await transport.ready;
  const socket = createConnection({ host: "127.0.0.1", port: transport.port() });
  try {
    await once(socket, "connect");
    const reader = readDesktopWire(socket);
    socket.write(encodeHello("voxelmon"));

    const ack = await reader.ack;
    const ackView = new DataView(ack.buffer, ack.byteOffset, ack.byteLength);
    expect(ackView.getUint32(0, true)).toBe(WIRE_MAGIC);
    expect(ackView.getUint8(4)).toBe(WIRE_VERSION);

    const open = await reader.nextFrame();
    expect(open.kind).toBe(WIRE_MSG.streamOpen);
    const openView = new DataView(open.payload.buffer, open.payload.byteOffset, open.payload.byteLength);
    const pathLength = openView.getUint16(0, true);
    const path = new TextDecoder().decode(open.payload.slice(2, 2 + pathLength));
    const headerOffset = 2 + pathLength;
    expect(path).toBe(DESKTOP_STREAM_REL_PATH);
    expect(openView.getUint32(headerOffset, true)).toBe(STREAM_MAGIC);
    expect(openView.getUint32(headerOffset + 8, true)).toBe(epoch);

    transport.broadcastFrame(42, RGB332_PALETTE, new Uint8Array(16 * 16).fill(7));
    const slot = await reader.nextFrame();
    expect(slot.kind).toBe(WIRE_MSG.videoSlot);
    expect(slot.flags).toBe(1); // the flat test frame takes the PackBits path
    const slotView = new DataView(slot.payload.buffer, slot.payload.byteOffset, slot.payload.byteLength);
    expect(slotView.getUint32(0, true)).toBe(1);
    expect(slotView.getUint32(4, true)).toBe(42);
    expect(slotView.getUint16(8, true)).toBe(16);
    expect(slotView.getUint16(10, true)).toBe(16);
    expect(slotView.getUint16(12, true)).toBe(1);
  } finally {
    socket.destroy();
    transport.close();
  }
});
