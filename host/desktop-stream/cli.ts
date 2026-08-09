import { homedir } from "node:os";
import { resolve } from "node:path";
import { WIRE_PORT } from "../../vendor/pocketjs/contracts/spec/spec.ts";

export interface DesktopStreamCli {
  dir: string;
  screen: number;
  device?: string;
  fps: number;
  ffmpeg: string;
  /** Undefined keeps all network sockets and discovery broadcasts disabled. */
  tcpPort?: number;
  help: boolean;
}

const expandHome = (path: string): string =>
  path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;

function takeValue(argv: readonly string[], at: number, flag: string): string {
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`desktop stream: ${flag} needs a value`);
  return value;
}

export function parseDesktopStreamCli(argv: readonly string[]): DesktopStreamCli {
  const out: DesktopStreamCli = {
    dir: `${homedir()}/.config/ppsspp`,
    screen: 0,
    fps: 12,
    ffmpeg: "ffmpeg",
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--dir") out.dir = takeValue(argv, i++, arg);
    else if (arg.startsWith("--dir=")) out.dir = arg.slice("--dir=".length);
    else if (arg === "--screen") out.screen = Number(takeValue(argv, i++, arg));
    else if (arg.startsWith("--screen=")) out.screen = Number(arg.slice("--screen=".length));
    else if (arg === "--device") out.device = takeValue(argv, i++, arg);
    else if (arg.startsWith("--device=")) out.device = arg.slice("--device=".length);
    else if (arg === "--fps") out.fps = Number(takeValue(argv, i++, arg));
    else if (arg.startsWith("--fps=")) out.fps = Number(arg.slice("--fps=".length));
    else if (arg === "--ffmpeg") out.ffmpeg = takeValue(argv, i++, arg);
    else if (arg.startsWith("--ffmpeg=")) out.ffmpeg = arg.slice("--ffmpeg=".length);
    else if (arg === "--tcp") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.tcpPort = Number(next);
        i++;
      } else {
        out.tcpPort = WIRE_PORT;
      }
    } else if (arg.startsWith("--tcp=")) out.tcpPort = Number(arg.slice("--tcp=".length));
    else throw new Error(`desktop stream: unknown option ${arg}`);
  }

  if (!Number.isInteger(out.screen) || out.screen < 0) {
    throw new Error("desktop stream: --screen must be a non-negative integer");
  }
  if (!Number.isInteger(out.fps) || out.fps < 1 || out.fps > 60) {
    throw new Error("desktop stream: --fps must be an integer from 1 through 60");
  }
  if (out.device !== undefined && out.device.trim() === "") {
    throw new Error("desktop stream: --device cannot be empty");
  }
  if (
    out.tcpPort !== undefined &&
    (!Number.isInteger(out.tcpPort) || out.tcpPort < 1 || out.tcpPort > 65_535)
  ) {
    throw new Error("desktop stream: --tcp port must be an integer from 1 through 65535");
  }
  if (!out.ffmpeg.trim()) throw new Error("desktop stream: --ffmpeg cannot be empty");
  out.dir = resolve(expandHome(out.dir));
  return out;
}

export const DESKTOP_STREAM_USAGE = `Usage: bun run desktop:serve -- [options]

  --dir <root>       PPSSPP/usbhostfs root (default: ~/.config/ppsspp)
  --screen <n>       macOS Capture screen N (default: 0)
  --device <name>    explicit AVFoundation video device; skips discovery
  --fps <n>          capture rate, 1..60 (default: 12)
  --ffmpeg <path>    ffmpeg executable (default: ffmpeg)
  --tcp [port]       enable Vita PKNT and LAN beacon (default: off; port ${WIRE_PORT})
  -h, --help         show this text`;
