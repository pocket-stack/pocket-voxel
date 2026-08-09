// Real-browser acceptance for the complete local ROM -> cook -> WASM path.
// The ROM is attached to a Chrome drag event by file path; it is never read by
// this process or served over HTTP.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VOX_BTN } from "../../contracts/spec/voxel-spec.ts";
import { resolveEnv } from "../../voxelmon/import/env.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const site = join(root, "dist/web");
const romPath = resolveEnv().romPath;
const chromeCandidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "google-chrome",
  "chromium",
].filter((candidate): candidate is string => Boolean(candidate));

function commandExists(command: string): boolean {
  if (command.includes("/")) return existsSync(command);
  return Bun.which(command) !== null;
}

const chrome = chromeCandidates.find(commandExists);
if (!chrome) {
  throw new Error("Chrome not found; set CHROME_BIN to a Chromium-compatible executable.");
}
if (!existsSync(romPath)) throw new Error(`ROM not found: ${romPath} (set VOXELMON_ROM)`);
if (Bun.file(romPath).size !== 1024 * 1024) throw new Error("The web e2e ROM must be exactly 1 MiB.");
const viewportWidth = Number(process.env.WEB_E2E_WIDTH ?? 1280);
const viewportHeight = Number(process.env.WEB_E2E_HEIGHT ?? 1200);

const build = Bun.spawnSync(["bun", "run", "web:build"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

type StageProfile = { lods?: { orbit?: unknown } };
const stageProfile = (await Bun.file(join(site, "assets", "game-boy", "profile.json")).json()) as StageProfile;
const orbitModel = stageProfile.lods?.orbit;
if (typeof orbitModel !== "string" || orbitModel.length === 0) {
  throw new Error("Game Boy stage profile does not declare lods.orbit");
}
const stageModelPath = `/assets/game-boy/${orbitModel}`;

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "") || "index.html";
    const path = resolve(site, relative);
    if (path !== site && !path.startsWith(`${site}/`)) return new Response("not found", { status: 404 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, {
      headers: {
        "content-type": mime[extname(path).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
});
const siteUrl = `http://127.0.0.1:${server.port}/`;

// Reserve an ephemeral port, then hand it to Chrome's DevTools endpoint.
const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
const cdpPort = reservation.port;
reservation.stop(true);
const profile = mkdtempSync(join(tmpdir(), "pocketvoxel-web-chrome-"));
const chromeProcess = Bun.spawn(
  [
    chrome,
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--force-device-scale-factor=1",
    `--window-size=${viewportWidth},${viewportHeight}`,
    "about:blank",
  ],
  { cwd: root, stdout: "ignore", stderr: "ignore" },
);

type Json = Record<string, unknown>;
type Handler = (params: Json) => void;

class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  private readonly handlers = new Map<string, Set<Handler>>();

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: Json; result?: Json; error?: Json };
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result ?? {});
        return;
      }
      if (message.method) {
        for (const handler of this.handlers.get(message.method) ?? []) handler(message.params ?? {});
      }
    };
    socket.onclose = () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("Chrome DevTools disconnected"));
      this.pending.clear();
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(() => rejectOpen(new Error("Chrome DevTools connection timed out")), 10_000);
      socket.onopen = () => {
        clearTimeout(timeout);
        resolveOpen();
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        rejectOpen(new Error("Chrome DevTools connection failed"));
      };
    });
    return new Cdp(socket);
  }

  send(method: string, params: Json = {}): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolveMessage, rejectMessage) => {
      this.pending.set(id, { resolve: resolveMessage, reject: rejectMessage });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: Handler): void {
    const set = this.handlers.get(method) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(method, set);
  }

  once(method: string): Promise<Json> {
    return new Promise((resolveEvent) => {
      const handler: Handler = (params) => {
        this.handlers.get(method)?.delete(handler);
        resolveEvent(params);
      };
      this.on(method, handler);
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function waitForDevtools(): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as Json[];
      const page = targets.find((target) => target.type === "page");
      if (typeof page?.webSocketDebuggerUrl === "string") return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error("Chrome did not expose a page target");
}

async function evaluate(cdp: Cdp, expression: string): Promise<unknown> {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(`browser evaluation failed: ${JSON.stringify(response.exceptionDetails)}`);
  return (response.result as Json | undefined)?.value;
}

async function waitUntil(cdp: Cdp, expression: string, timeoutMs = 180_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await Bun.sleep(100);
  }
  throw new Error(`browser condition timed out: ${expression}`);
}

let cdp: Cdp | null = null;
try {
  cdp = await Cdp.connect(await waitForDevtools());
  const requests: { method: string; url: string; hasBody: boolean }[] = [];
  const browserErrors: string[] = [];
  const failedResponses: { status: number; url: string }[] = [];
  const responseTypes = new Map<string, string>();
  cdp.on("Network.requestWillBeSent", (params) => {
    const request = params.request as Json;
    requests.push({
      method: String(request.method),
      url: String(request.url),
      hasBody: typeof request.postData === "string" && request.postData.length > 0,
    });
  });
  cdp.on("Runtime.exceptionThrown", (params) => browserErrors.push(JSON.stringify(params)));
  cdp.on("Network.responseReceived", (params) => {
    const response = params.response as Json;
    const status = Number(response.status);
    const responseUrl = String(response.url);
    if (responseUrl.startsWith(siteUrl)) {
      responseTypes.set(new URL(responseUrl).pathname, String(response.mimeType));
    }
    if (status >= 400) failedResponses.push({ status, url: responseUrl });
  });
  cdp.on("Log.entryAdded", (params) => {
    const entry = params.entry as Json;
    // Network.responseReceived carries the actionable URL and status. Chrome's
    // generic console duplicate has neither, so do not report it twice.
    if (entry.level === "error" && entry.source !== "network") browserErrors.push(String(entry.text));
  });
  cdp.on("Runtime.consoleAPICalled", (params) => {
    if (params.type === "error" || params.type === "assert") browserErrors.push(JSON.stringify(params));
  });

  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Network.enable"),
    cdp.send("Log.enable"),
    cdp.send("DOM.enable"),
  ]);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewportWidth,
    height: viewportHeight,
    deviceScaleFactor: 1,
    // Keep desktop input semantics so CDP can attach a local ROM through a
    // drag event while still exercising narrow responsive CSS widths.
    mobile: false,
  });
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: siteUrl });
  await loaded;
  await waitUntil(
    cdp,
    `document.readyState === "complete" &&
      typeof globalThis.__pocketVoxelStageReceipt === "function" &&
      (() => {
        const receipt = globalThis.__pocketVoxelStageReceipt();
        return receipt.modelReady === true && receipt.ready === false &&
          Number.isFinite(receipt.stageFrames) && Number.isFinite(receipt.screenFrames) &&
          Number.isFinite(receipt.inputMask) && "pressedPart" in receipt;
      })()`,
    20_000,
  );
  await evaluate(
    cdp,
    `document.querySelector("[data-stage-viewport]").scrollIntoView({block:"center", inline:"center"})`,
  );
  await waitUntil(cdp, `globalThis.__pocketVoxelStageReceipt().stageFrames > 0`, 5_000);

  if (viewportWidth >= 600) {
    const dropPoint = (await evaluate(
      cdp,
      `(() => {
        const target = document.querySelector("[data-stage-viewport]") || document.body;
        const r = target.getBoundingClientRect();
        return {x:r.left+r.width/2,y:r.top+r.height/2};
      })()`,
    )) as { x: number; y: number };
    const dragData = { items: [], files: [romPath], dragOperationsMask: 1 };
    await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", ...dropPoint, data: dragData });
    await cdp.send("Input.dispatchDragEvent", { type: "dragOver", ...dropPoint, data: dragData });
    await cdp.send("Input.dispatchDragEvent", { type: "drop", ...dropPoint, data: dragData });
  } else {
    // CDP does not attach drag files while narrow device metrics are active.
    // Use the same real file input path to keep responsive acceptance honest.
    const documentNode = await cdp.send("DOM.getDocument");
    const inputNode = await cdp.send("DOM.querySelector", {
      nodeId: (documentNode.root as Json).nodeId,
      selector: "#rom-file",
    });
    await cdp.send("DOM.setFileInputFiles", {
      nodeId: inputNode.nodeId,
      files: [romPath],
    });
    await Bun.sleep(50);
    if (await evaluate(cdp, `document.getElementById("gameboy-stage").dataset.state === "idle"`)) {
      await evaluate(
        cdp,
        `document.getElementById("rom-file").dispatchEvent(new Event("change", {bubbles:true}))`,
      );
    }
  }

  await waitUntil(cdp, `(() => {
    const canvas = document.getElementById("screen");
    const receipt = globalThis.__pocketVoxelStageReceipt?.();
    return canvas?.width === 480 && canvas?.height === 272 && receipt?.ready === true;
  })()`);
  const liveStart = (await evaluate(
    cdp,
    `(() => {
      const receipt = globalThis.__pocketVoxelStageReceipt();
      return {screenFrames:receipt.screenFrames,stageFrames:receipt.stageFrames};
    })()`,
  )) as { screenFrames: number; stageFrames: number };
  await waitUntil(
    cdp,
    `(() => {
      const receipt = globalThis.__pocketVoxelStageReceipt();
      return receipt.screenFrames >= ${liveStart.screenFrames + 2} &&
        receipt.stageFrames >= ${liveStart.stageFrames + 2};
    })()`,
    5_000,
  );
  const frame = await evaluate(
    cdp,
    `(() => {
      const canvas = document.getElementById("screen");
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261 >>> 0;
      const colors = new Set();
      for (let i = 0; i < pixels.length; i++) {
        hash ^= pixels[i]; hash = Math.imul(hash, 16777619) >>> 0;
        if ((i & 1023) === 0) colors.add((pixels[i] << 16) | (pixels[i+1] << 8) | pixels[i+2]);
      }
      return {width:canvas.width,height:canvas.height,hash:hash.toString(16).padStart(8,"0"),sampledColors:colors.size};
    })()`,
  ) as { width: number; height: number; hash: string; sampledColors: number };
  if (frame.width !== 480 || frame.height !== 272 || frame.sampledColors < 2) {
    throw new Error(`invalid rendered frame: ${JSON.stringify(frame)}`);
  }

  const focused = await evaluate(
    cdp,
    `(() => {
      const canvas = document.querySelector("canvas:not(#screen)");
      canvas?.focus();
      return canvas instanceof HTMLCanvasElement && document.activeElement === canvas;
    })()`,
  );
  if (!focused) throw new Error("3D stage canvas could not receive keyboard focus");

  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "z",
    code: "KeyZ",
    windowsVirtualKeyCode: 90,
    nativeVirtualKeyCode: 90,
  });
  await waitUntil(
    cdp,
    `(globalThis.__pocketVoxelStageReceipt().inputMask & ${VOX_BTN.a}) !== 0`,
    5_000,
  );
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "z",
    code: "KeyZ",
    windowsVirtualKeyCode: 90,
    nativeVirtualKeyCode: 90,
  });
  await waitUntil(
    cdp,
    `(globalThis.__pocketVoxelStageReceipt().inputMask & ${VOX_BTN.a}) === 0`,
    5_000,
  );

  const modelA = (await evaluate(
    cdp,
    `globalThis.__pocketVoxelStageReceipt().controlPoints.button_a`,
  )) as { x: number; y: number };
  if (!Number.isFinite(modelA.x) || !Number.isFinite(modelA.y)) {
    throw new Error(`Game Boy A button has no projected hit point: ${JSON.stringify(modelA)}`);
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: modelA.x,
    y: modelA.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await waitUntil(
    cdp,
    `(globalThis.__pocketVoxelStageReceipt().inputMask & ${VOX_BTN.a}) !== 0`,
    5_000,
  );
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: modelA.x,
    y: modelA.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await waitUntil(
    cdp,
    `(globalThis.__pocketVoxelStageReceipt().inputMask & ${VOX_BTN.a}) === 0`,
    5_000,
  );

  const stageLayout = (await evaluate(
    cdp,
    `(() => ({
      bounds:document.getElementById("stage-canvas").getBoundingClientRect().toJSON(),
      points:globalThis.__pocketVoxelStageReceipt().controlPoints,
    }))()`,
  )) as {
    bounds: { left: number; right: number; top: number; bottom: number };
    points: Record<string, { x: number; y: number }>;
  };
  for (const [name, point] of Object.entries(stageLayout.points)) {
    if (
      point.x < stageLayout.bounds.left || point.x > stageLayout.bounds.right ||
      point.y < stageLayout.bounds.top || point.y > stageLayout.bounds.bottom
    ) {
      throw new Error(`${name} falls outside the responsive stage: ${JSON.stringify({ point, bounds: stageLayout.bounds })}`);
    }
  }

  const modelB = stageLayout.points.button_b;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: modelA.x, y: modelA.y, button: "left", buttons: 1, clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: modelA.x, y: modelA.y, button: "left", buttons: 0, clickCount: 1,
  });
  await Bun.sleep(5);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: modelB.x, y: modelB.y, button: "left", buttons: 1, clickCount: 1,
  });
  await waitUntil(
    cdp,
    `(() => {
      const mask = globalThis.__pocketVoxelStageReceipt().inputMask;
      return (mask & ${VOX_BTN.b}) !== 0 && (mask & ${VOX_BTN.a}) === 0;
    })()`,
    5_000,
  );
  await Bun.sleep(55);
  if (!await evaluate(cdp, `(globalThis.__pocketVoxelStageReceipt().inputMask & ${VOX_BTN.b}) !== 0`)) {
    throw new Error("a stale pointer-release timer cleared the next Game Boy button press");
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: modelB.x, y: modelB.y, button: "left", buttons: 0, clickCount: 1,
  });
  await waitUntil(cdp, `globalThis.__pocketVoxelStageReceipt().inputMask === 0`, 5_000);

  const origin = new URL(siteUrl).origin;
  const requestPaths = new Set(requests.map((request) => new URL(request.url).pathname));
  for (const required of [
    "/main.js",
    "/cook.worker.js",
    "/generated/pocketvoxel_wasm.js",
    "/generated/pocketvoxel_wasm_bg.wasm",
    "/assets/game-boy/profile.json",
    stageModelPath,
  ]) {
    if (!requestPaths.has(required)) throw new Error(`browser did not load ${required}`);
  }
  if (responseTypes.get(stageModelPath) !== "model/gltf-binary") {
    throw new Error(
      `Game Boy model used ${responseTypes.get(stageModelPath) ?? "no"} MIME type; expected model/gltf-binary`,
    );
  }
  const unsafeRequests = requests.filter((request) => {
    const url = new URL(request.url);
    return url.origin !== origin || request.method !== "GET" || request.hasBody;
  });
  if (unsafeRequests.length > 0) throw new Error(`unexpected network requests: ${JSON.stringify(unsafeRequests)}`);
  if (failedResponses.length > 0) {
    throw new Error(`failed browser resources: ${JSON.stringify(failedResponses)}`);
  }
  if (browserErrors.length > 0) throw new Error(`browser errors: ${browserErrors.join("\n")}`);

  const ui = await evaluate(
    cdp,
    `({
      status:document.getElementById("live-status").textContent,
      stage:globalThis.__pocketVoxelStageReceipt(),
    })`,
  );
  const screenshotPath = process.env.WEB_E2E_SCREENSHOT;
  if (screenshotPath) {
    const capture = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
    });
    await Bun.write(screenshotPath, Buffer.from(String(capture.data), "base64"));
  }
  console.log(
    `Pocket Voxel Chrome e2e: drag/cook/3D-stage/input PASS ${JSON.stringify({ frame, ui, requests: requests.length, screenshotPath })}`,
  );
} finally {
  cdp?.close();
  chromeProcess.kill();
  server.stop(true);
  rmSync(profile, { recursive: true, force: true });
}
