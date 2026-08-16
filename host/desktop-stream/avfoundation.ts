export interface CaptureScreen {
  /** AVFoundation's input-device index, not the screen ordinal in its name. */
  deviceIndex: number;
  /** The N from the stable `Capture screen N` device name. */
  screen: number;
  name: string;
}

export function parseCaptureScreens(stderr: string): CaptureScreen[] {
  const screens: CaptureScreen[] = [];
  for (const line of stderr.split("\n")) {
    const match = line.match(/\[(\d+)\]\s+(Capture screen\s+(\d+))\s*$/i);
    if (!match) continue;
    screens.push({ deviceIndex: Number(match[1]), name: match[2], screen: Number(match[3]) });
  }
  return screens;
}

export async function discoverCaptureScreens(ffmpeg = "ffmpeg"): Promise<CaptureScreen[]> {
  const proc = Bun.spawn(
    [ffmpeg, "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
    { stdout: "ignore", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  await proc.exited; // listing deliberately exits non-zero because no input opens
  const screens = parseCaptureScreens(stderr);
  if (screens.length === 0) {
    throw new Error(
      `desktop stream: ffmpeg did not report an AVFoundation screen device\n${stderr.trim().slice(-800)}`,
    );
  }
  return screens;
}

export function selectCaptureScreen(screens: readonly CaptureScreen[], screen: number): CaptureScreen {
  const exact = screens.find((candidate) => candidate.screen === screen);
  if (exact) return exact;
  const available = screens.map((candidate) => candidate.screen).join(", ");
  throw new Error(`desktop stream: Capture screen ${screen} was not found (available: ${available})`);
}

/**
 * Capture into a 512x128 texture that is stretched into a 2:1 desktop window.
 * The 2:1 SAR before scale doubles the content's stored width; reset_sar then
 * bakes that correction into the pixels instead of leaving metadata the raw
 * RGB stream cannot carry. A 16:10 Mac display therefore occupies 410x128
 * texels and regains 16:10 when the device stretches 512x128 to 360x180.
 * AVFoundation's screen source can ignore its requested input rate and emit
 * duplicate frames as fast as the pipe drains, so the output graph owns the
 * authoritative fps gate before doing any scaling work.
 */
export function captureCommand(
  ffmpeg: string,
  device: string,
  fps: number,
  width: number,
  height: number,
): string[] {
  return [
    ffmpeg,
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "avfoundation",
    "-framerate",
    String(fps),
    "-capture_cursor",
    "1",
    "-capture_mouse_clicks",
    "1",
    // Ask AVFoundation for a native packed format. Without this it first
    // negotiates yuv420p and logs a misleading fallback warning on macOS.
    "-pixel_format",
    "bgr0",
    "-i",
    `${device}:none`,
    "-vf",
    `fps=${fps},setsar=2/1,scale=${width}:${height}:force_original_aspect_ratio=decrease:reset_sar=1:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
    "-an",
    "-sn",
    "-dn",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ];
}
