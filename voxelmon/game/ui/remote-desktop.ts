// The remote bedroom PC's presentation program. The host owns the captured
// pixels and stream lifecycle; this module draws only a centered Win98 shell
// around the one native video plane, using the same retained overlay surface
// as the local PC.

import type { VoxelHost } from "../host.ts";

export type RemotePcStatus = "waiting" | "live";

export interface RemotePcSource {
  /** Incremented only when visible shell state changes. */
  revision: number;
  status: RemotePcStatus;
  /** Latest host frame for diagnostics; the shell does not repaint per frame. */
  frameIndex: number;
}

/** The daemon pre-squashes 512x128 for a 2:1 destination. Keep that aspect
 * exactly so a captured Mac display regains its native proportions here. */
export const REMOTE_VIDEO_PLANE = { x: 60, y: 44, w: 360, h: 180 } as const;

const rgb = (r: number, g: number, b: number): number =>
  (0xff00_0000 | (b << 16) | (g << 8) | r) | 0;

const C = {
  black: rgb(0x00, 0x00, 0x00),
  white: rgb(0xff, 0xff, 0xff),
  face: rgb(0xc0, 0xc0, 0xc0),
  light: rgb(0xdf, 0xdf, 0xdf),
  shadow: rgb(0x80, 0x80, 0x80),
  title: rgb(0x00, 0x00, 0x80),
  title2: rgb(0x10, 0x84, 0xd0),
  live: rgb(0x20, 0xd0, 0x58),
  waiting: rgb(0xf8, 0xd0, 0x30),
} as const;

function rect(host: VoxelHost, x: number, y: number, w: number, h: number, color: number): void {
  if (w > 0 && h > 0) host.uiRect(x, y, w, h, color);
}

function label(host: VoxelHost, x: number, y: number, text: string, color = C.black): void {
  host.uiLabel(x, y, 1, color, text);
}

function titleGradient(host: VoxelHost, x: number, y: number, w: number, h: number): void {
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const x0 = x + Math.floor((w * i) / 8);
    const x1 = x + Math.floor((w * (i + 1)) / 8);
    rect(
      host,
      x0,
      y,
      x1 - x0,
      h,
      rgb(Math.round(0x10 * t), Math.round(0x84 * t), Math.round(0x80 + 0x50 * t)),
    );
  }
}

/** Draw a bevel's edges only: a filled overlay would cover VideoQuad. */
function raisedFrame(host: VoxelHost, x: number, y: number, w: number, h: number): void {
  rect(host, x, y, w - 1, 1, C.white);
  rect(host, x, y, 1, h - 1, C.white);
  rect(host, x + 1, y + 1, w - 3, 1, C.light);
  rect(host, x + 1, y + 1, 1, h - 3, C.light);
  rect(host, x + w - 2, y + 1, 1, h - 1, C.shadow);
  rect(host, x + 1, y + h - 2, w - 1, 1, C.shadow);
  rect(host, x + w - 1, y, 1, h, C.black);
  rect(host, x, y + h - 1, w, 1, C.black);
}

function sunkenFrame(host: VoxelHost, x: number, y: number, w: number, h: number): void {
  rect(host, x, y, w - 1, 1, C.shadow);
  rect(host, x, y, 1, h - 1, C.shadow);
  rect(host, x + 1, y + 1, w - 3, 1, C.black);
  rect(host, x + 1, y + 1, 1, h - 3, C.black);
  rect(host, x + w - 2, y + 1, 1, h - 1, C.light);
  rect(host, x + 1, y + h - 2, w - 1, 1, C.light);
  rect(host, x + w - 1, y, 1, h, C.white);
  rect(host, x, y + h - 1, w, 1, C.white);
}

/** Rebuild the shell when WAITING/LIVE changes, never once per video frame. */
export function emitRemoteDesktop(host: VoxelHost, view: RemotePcSource): void {
  const x = 42;
  const y = 13;
  const w = 396;
  const h = 246;
  const p = REMOTE_VIDEO_PLANE;

  // Fill only the four bands outside the video. Overlay is the final pass,
  // so a single full-window fill would conceal the host-owned VideoQuad.
  rect(host, x, y, w, p.y - y, C.face);
  rect(host, x, p.y + p.h, w, y + h - (p.y + p.h), C.face);
  rect(host, x, p.y, p.x - x, p.h, C.face);
  rect(host, p.x + p.w, p.y, x + w - (p.x + p.w), p.h, C.face);
  raisedFrame(host, x, y, w, h);

  titleGradient(host, x + 4, y + 4, w - 8, 18);
  label(host, x + 10, y + 10, "PALLETNET REMOTE", C.white);
  const statusColor = view.status === "live" ? C.live : C.waiting;
  rect(host, x + w - 111, y + 9, 6, 6, statusColor);
  label(host, x + w - 101, y + 10, view.status === "live" ? "LIVE" : "WAITING", C.white);

  // Caption close button; hardware B/START calls the same close path.
  rect(host, x + w - 23, y + 6, 16, 14, C.face);
  raisedFrame(host, x + w - 23, y + 6, 16, 14);
  label(host, x + w - 18, y + 10, "X");

  sunkenFrame(host, p.x - 3, p.y - 3, p.w + 6, p.h + 6);
  if (view.status === "waiting") {
    rect(host, p.x, p.y, p.w, p.h, C.black);
    label(host, p.x + 102, p.y + 76, "CONNECTING TO PALLETNET...", C.white);
    label(host, p.x + 141, p.y + 90, "RETRYING HOST", C.waiting);
  }

  const statusY = p.y + p.h + 7;
  sunkenFrame(host, x + 10, statusY, w - 20, 20);
  label(
    host,
    x + 17,
    statusY + 7,
    view.status === "live" ? "STREAM ACTIVE   B/START DISCONNECT" : "HOST OFFLINE   RETRYING   B/START DISCONNECT",
  );
}
