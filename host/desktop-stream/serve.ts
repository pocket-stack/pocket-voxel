import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverCaptureScreens, selectCaptureScreen } from "./avfoundation.ts";
import { DesktopCapture } from "./capture.ts";
import { DESKTOP_STREAM_USAGE, parseDesktopStreamCli } from "./cli.ts";
import { startDesktopBeacon } from "./discovery.ts";
import { DEFAULT_DESKTOP_GEOMETRY } from "./pkst.ts";
import {
  startDesktopTcpTransport,
  type DesktopTcpTransport,
} from "./tcp.ts";

const APP_ID = "voxelmon";

export async function runDesktopStreamDaemon(argv: readonly string[]): Promise<void> {
  const cli = parseDesktopStreamCli(argv);
  if (cli.help) {
    console.log(DESKTOP_STREAM_USAGE);
    return;
  }

  const device =
    cli.device ?? selectCaptureScreen(await discoverCaptureScreens(cli.ffmpeg), cli.screen).name;
  const geometry = { ...DEFAULT_DESKTOP_GEOMETRY, fpsNum: cli.fps };
  const serviceDir = join(cli.dir, "pocket-svc", "voxelmon");
  const mediaDir = join(serviceDir, "media");
  const streamPath = join(mediaDir, "desktop.pkst");
  mkdirSync(mediaDir, { recursive: true });
  // These files make the directory a normal PocketJS companion service. The
  // first remote-computer client can probe it before opening desktop.pkst.
  writeFileSync(join(serviceDir, "enable"), "");
  writeFileSync(join(serviceDir, "in.jsonl"), "");
  writeFileSync(join(serviceDir, "out.jsonl"), "");

  console.log(`voxelmon desktop stream: ${device}`);
  console.log(`voxelmon desktop stream: ${geometry.w}x${geometry.h}@${cli.fps} CLUT8`);
  console.log(`voxelmon desktop stream: ${streamPath}`);

  let capture: DesktopCapture | null = null;
  let tcp: DesktopTcpTransport | null = null;
  let stopBeacon: (() => void) | null = null;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log("voxelmon desktop stream: stopping");
    capture?.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    if (cli.tcpPort !== undefined) {
      tcp = startDesktopTcpTransport({
        port: cli.tcpPort,
        app: APP_ID,
        geometry,
      });
      await tcp.ready;
      stopBeacon = startDesktopBeacon(APP_ID, tcp.port());
      console.log(
        `voxelmon desktop stream: LAN streaming enabled on TCP ${tcp.port()} (--tcp exposes this screen to the local network)`,
      );
    }
    if (stopping) return;

    let announced = false;
    capture = new DesktopCapture({
      ffmpeg: cli.ffmpeg,
      device,
      geometry,
      streamPath,
      onClutFrame(frameIndex, palette, indices) {
        tcp?.broadcastFrame(frameIndex, palette, indices);
      },
      onFrame(count) {
        if (!announced && count > 0) {
          announced = true;
          console.log("voxelmon desktop stream: first frame published");
        }
      },
    });

    const result = await capture.done;
    if (!result.stopped && (result.code !== 0 || result.frames === 0)) {
      const details = result.stderr.trim().slice(-1200);
      const permission =
        result.frames === 0
          ? " Grant Screen Recording permission to the terminal running Bun in System Settings > Privacy & Security."
          : "";
      const failure = result.code === 0 ? "produced no frames" : `exited with ${result.code}`;
      throw new Error(`desktop stream: ffmpeg ${failure}.${permission}\n${details}`);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    stopBeacon?.();
    tcp?.close();
  }
}

if (import.meta.main) {
  runDesktopStreamDaemon(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
