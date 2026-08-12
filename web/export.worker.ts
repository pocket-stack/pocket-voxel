/// <reference lib="webworker" />

import type {
  ExportRequest,
  ExportWorkerMessage,
  NativeTarget,
} from "./export-protocol.ts";
import { errorMessage } from "./protocol.ts";

interface TemplateFile {
  id: string;
  path: string;
  bytes: number;
  sha256: string;
}

interface TemplateManifest {
  schemaVersion: number;
  vxpkVersion: number;
  psp: { files: TemplateFile[] };
  vita: { files: TemplateFile[] };
}

interface PackagerGlue {
  default(input?: { module_or_path: URL | RequestInfo | WebAssembly.Module }): Promise<unknown>;
  build_psp_install_zip(
    prx: Uint8Array,
    icon0: Uint8Array,
    pic1: Uint8Array,
    notices: Uint8Array,
    pak: Uint8Array,
  ): Uint8Array;
  build_vita_vpk(
    eboot: Uint8Array,
    sfo: Uint8Array,
    icon0: Uint8Array,
    background: Uint8Array,
    startup: Uint8Array,
    template: Uint8Array,
    notices: Uint8Array,
    pak: Uint8Array,
  ): Uint8Array;
}

const context = self as unknown as DedicatedWorkerGlobalScope;
const manifestUrl = new URL("./platform/manifest.json", context.location.href);
let gluePromise: Promise<PackagerGlue> | null = null;
let manifestPromise: Promise<TemplateManifest> | null = null;

function progress(jobId: number, target: NativeTarget, fraction: number, label: string): void {
  context.postMessage({ type: "progress", jobId, target, fraction, label } satisfies ExportWorkerMessage);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!crypto.subtle) throw new Error("Web Crypto is unavailable; cannot validate platform templates.");
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeTemplatePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe platform template path: ${path}`);
  }
}

async function loadManifest(): Promise<TemplateManifest> {
  manifestPromise ??= (async () => {
    const response = await fetch(manifestUrl, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Platform manifest returned HTTP ${response.status}.`);
    const manifest = await response.json() as TemplateManifest;
    if (manifest.schemaVersion !== 1 || manifest.vxpkVersion !== 8) {
      throw new Error("Platform templates do not match this Pocket Voxel build.");
    }
    for (const file of [...manifest.psp.files, ...manifest.vita.files]) {
      safeTemplatePath(file.path);
      if (!file.id || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 ||
          !/^[0-9a-f]{64}$/.test(file.sha256)) {
        throw new Error(`Platform manifest has an invalid entry for ${file.path}.`);
      }
    }
    return manifest;
  })();
  return manifestPromise;
}

async function loadGlue(): Promise<PackagerGlue> {
  gluePromise ??= (async () => {
    const glueUrl = new URL("./generated/pocketvoxel_packager_wasm.js", context.location.href).href;
    const wasmUrl = new URL("./generated/pocketvoxel_packager_wasm_bg.wasm", context.location.href);
    const glue = await import(glueUrl) as PackagerGlue;
    await glue.default({ module_or_path: wasmUrl });
    return glue;
  })();
  return gluePromise;
}

async function loadFiles(files: TemplateFile[]): Promise<Map<string, Uint8Array>> {
  const loaded = await Promise.all(files.map(async (file) => {
    const url = new URL(file.path, manifestUrl);
    if (url.origin !== manifestUrl.origin) throw new Error(`Platform template left this origin: ${file.path}`);
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`${file.path} returned HTTP ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== file.bytes) {
      throw new Error(`${file.path} size mismatch: got ${bytes.byteLength}, need ${file.bytes}.`);
    }
    const actual = await sha256(bytes);
    if (actual !== file.sha256) throw new Error(`${file.path} failed its SHA-256 check.`);
    return [file.id, bytes] as const;
  }));
  const byId = new Map(loaded);
  if (byId.size !== files.length) throw new Error("Platform manifest repeats a template id.");
  return byId;
}

function required(files: Map<string, Uint8Array>, id: string): Uint8Array {
  const bytes = files.get(id);
  if (!bytes) throw new Error(`Platform template is missing ${id}.`);
  return bytes;
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength &&
      bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

context.onmessage = async ({ data }: MessageEvent<ExportRequest>) => {
  if (data.type !== "build") return;
  const started = performance.now();
  try {
    progress(data.jobId, data.target, 0.05, "Loading package manifest");
    const manifest = await loadManifest();
    const template = data.target === "psp" ? manifest.psp : manifest.vita;
    progress(data.jobId, data.target, 0.15, "Validating native templates");
    const [glue, files] = await Promise.all([loadGlue(), loadFiles(template.files)]);
    progress(data.jobId, data.target, 0.62, "Compressing cooked world in WASM");
    const pak = new Uint8Array(data.pak);
    const artifact = data.target === "psp"
      ? glue.build_psp_install_zip(
          required(files, "prx"),
          required(files, "icon0"),
          required(files, "pic1"),
          required(files, "notices"),
          pak,
        )
      : glue.build_vita_vpk(
          required(files, "eboot"),
          required(files, "sfo"),
          required(files, "icon0"),
          required(files, "background"),
          required(files, "startup"),
          required(files, "template"),
          required(files, "notices"),
          pak,
        );
    const output = exactBuffer(artifact);
    const filename = data.target === "psp" ? "PocketVoxel-PSP.zip" : "PocketVoxel.vpk";
    const mime = data.target === "psp" ? "application/zip" : "application/vnd.sony.vita.vpk";
    progress(data.jobId, data.target, 1, "Package ready");
    context.postMessage({
      type: "ready",
      jobId: data.jobId,
      target: data.target,
      artifact: output,
      filename,
      mime,
      bytes: output.byteLength,
      elapsedMs: performance.now() - started,
    } satisfies ExportWorkerMessage, [output]);
  } catch (error) {
    context.postMessage({
      type: "error",
      jobId: data.jobId,
      target: data.target,
      message: errorMessage(error),
    } satisfies ExportWorkerMessage);
  }
};
