import { createSocket } from "node:dgram";
import { hostname } from "node:os";
import { WIRE_BEACON_PORT } from "../../vendor/pocketjs/contracts/spec/spec.ts";
import { encodeBeacon } from "./wire.ts";

/** Explicit opt-in only: the daemon calls this exclusively when --tcp is set. */
export function startDesktopBeacon(app: string, tcpPort: number): () => void {
  const socket = createSocket("udp4");
  const payload = encodeBeacon(tcpPort, app, hostname());
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const announce = () => {
    if (!closed) socket.send(payload, WIRE_BEACON_PORT, "255.255.255.255", () => {});
  };
  socket.bind(() => {
    if (closed) {
      socket.close();
      return;
    }
    socket.setBroadcast(true);
    announce();
    timer = setInterval(announce, 1_000);
  });
  return () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    try {
      socket.close();
    } catch {
      // Closing before the asynchronous bind callback is harmless.
    }
  };
}
