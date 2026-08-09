// Opt-in PKNT transport for the Vita. This is the video-only subset of
// pocket-youtube's MIT-licensed transport: one fixed stream, no ctrl/files,
// and latest-only backpressure for frames.

import { createServer, type Server, type Socket } from "node:net";
import { packbitsEncode } from "../../vendor/pocketjs/contracts/spec/spec.ts";
import {
  createDesktopSessionEpoch,
  type DesktopStreamGeometry,
} from "./pkst.ts";
import {
  drainFrames,
  encodeFrame,
  encodeHelloAck,
  encodePathPayload,
  encodeVideoSlot,
  headerBlock,
  parseHello,
  WIRE_MSG,
} from "./wire.ts";

const PING_EVERY_MS = 2_000;
const SILENCE_DROP_MS = 10_000;
export const DESKTOP_STREAM_REL_PATH = "media/desktop.pkst";

export interface DesktopTcpTransportOptions {
  port: number;
  app: string;
  geometry: DesktopStreamGeometry;
  /** The device-side service-relative path is fixed by default. */
  streamPath?: string;
  /** Test seam; production transports generate a fresh non-zero session. */
  epoch?: number;
}

export interface DesktopTcpTransport {
  server: Server;
  /** Resolves after bind and rejects on errors such as an occupied port. */
  ready: Promise<void>;
  port(): number;
  broadcastFrame(frameIndex: number, palette: Uint8Array, indices: Uint8Array): void;
  close(): void;
}

class DesktopConnection {
  readonly remote: string;
  private readonly socket: Socket;
  private readonly geometry: DesktopStreamGeometry;
  private pendingSlot: Uint8Array | null = null;
  private canWrite = true;
  private videoSeq = 0;

  constructor(
    socket: Socket,
    geometry: DesktopStreamGeometry,
    streamPath: string,
    epoch: number,
  ) {
    this.socket = socket;
    this.geometry = geometry;
    this.remote = `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? 0}`;
    socket.on("drain", () => {
      this.canWrite = true;
      const pending = this.pendingSlot;
      this.pendingSlot = null;
      if (pending) this.send(pending);
    });
    this.send(
      encodeFrame(
        WIRE_MSG.streamOpen,
        0,
        encodePathPayload(streamPath, headerBlock(geometry, epoch)),
      ),
    );
  }

  private send(frame: Uint8Array): void {
    if (this.socket.destroyed) return;
    this.canWrite = this.socket.write(frame);
  }

  ping(token: number): void {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, token, true);
    this.send(encodeFrame(WIRE_MSG.ping, 0, payload));
  }

  writeFrame(frameIndex: number, palette: Uint8Array, indices: Uint8Array): void {
    if (palette.length !== 1024 || indices.length !== this.geometry.w * this.geometry.h) {
      throw new Error("desktop stream: CLUT8 frame has the wrong size");
    }
    const seq = ++this.videoSeq;
    const encoded = packbitsEncode(indices);
    const useRle = encoded.length < indices.length;
    const payload = encodeVideoSlot(
      seq,
      frameIndex,
      this.geometry.w,
      this.geometry.h,
      palette,
      useRle ? encoded : indices,
      useRle,
    );
    const slot = encodeFrame(WIRE_MSG.videoSlot, useRle ? 1 : 0, payload);
    if (!this.canWrite) {
      // The live desktop has no useful historical backlog. Keep only the most
      // recent converted frame while the Wi-Fi socket drains.
      this.pendingSlot = slot;
      return;
    }
    this.send(slot);
  }

  close(): void {
    this.pendingSlot = null;
    if (this.socket.destroyed) return;
    this.socket.end(encodeFrame(WIRE_MSG.streamClose, 0, new Uint8Array(0)));
  }
}

export function startDesktopTcpTransport(
  options: DesktopTcpTransportOptions,
): DesktopTcpTransport {
  // Validate the injected value before accepting a device connection. In
  // production every streamOpen gets a fresh epoch because its video seq
  // restarts at one; a reconnect that happens between two game ticks must
  // still invalidate the device's old presented watermark.
  if (options.epoch !== undefined) headerBlock(options.geometry, options.epoch);
  const streamPath = options.streamPath ?? DESKTOP_STREAM_REL_PATH;
  const connections = new Set<DesktopConnection>();
  const sockets = new Set<Socket>();
  let closing = false;

  const server = createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setNoDelay(true);
    let buffer: Uint8Array = new Uint8Array(0);
    let connection: DesktopConnection | null = null;
    let lastRx = Date.now();
    let pingToken = 0;

    const pinger = setInterval(() => {
      if (Date.now() - lastRx > SILENCE_DROP_MS) {
        socket.destroy();
        return;
      }
      connection?.ping(++pingToken);
    }, PING_EVERY_MS);

    socket.on("data", (chunk: Buffer) => {
      lastRx = Date.now();
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer);
      merged.set(chunk, buffer.length);
      buffer = merged;

      if (!connection) {
        const hello = parseHello(buffer);
        if (hello === null) return;
        if (hello === "bad" || hello.app !== options.app) {
          socket.destroy();
          return;
        }
        buffer = buffer.slice(hello.consumed);
        socket.write(encodeHelloAck());
        connection = new DesktopConnection(
          socket,
          options.geometry,
          streamPath,
          options.epoch ?? createDesktopSessionEpoch(),
        );
        connections.add(connection);
        console.log(`voxelmon desktop stream: Vita connected from ${connection.remote}`);
      }

      try {
        // The desktop-only daemon has no device commands. Parsing still
        // enforces frame bounds; pong and future message types count as life.
        ({ rest: buffer } = drainFrames(buffer));
      } catch {
        socket.destroy();
      }
    });

    socket.on("close", () => {
      clearInterval(pinger);
      sockets.delete(socket);
      if (connection) {
        connections.delete(connection);
        console.log(`voxelmon desktop stream: Vita ${connection.remote} disconnected`);
      }
    });
    socket.on("error", () => {
      // close follows and owns cleanup
    });
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.listen(options.port, "0.0.0.0");

  return {
    server,
    ready,
    port() {
      const address = server.address();
      return typeof address === "object" && address ? address.port : options.port;
    },
    broadcastFrame(frameIndex, palette, indices) {
      for (const connection of connections) {
        connection.writeFrame(frameIndex, palette, indices);
      }
    },
    close() {
      if (closing) return;
      closing = true;
      for (const connection of connections) connection.close();
      connections.clear();
      for (const socket of sockets) socket.destroySoon();
      sockets.clear();
      try {
        server.close();
      } catch {
        // Bind may have failed before the caller reached cleanup.
      }
    },
  };
}
