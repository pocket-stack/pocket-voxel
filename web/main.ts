import { RED_ROM_BYTES } from "../voxelmon/import/constants.ts";
import { BrowserAudio } from "./audio.ts";
import { attachKeyboard, InputMux } from "./input.ts";
import type { WorkerMessage, WorkerRequest } from "./protocol.ts";
import { WebRuntime } from "./runtime.ts";
import { mountGameBoyStage, type GameBoyStage } from "./stage.ts";

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
};

const stageRoot = byId<HTMLElement>("gameboy-stage");
const stageViewport = byId<HTMLElement>("stage-viewport");
const stageCanvas = byId<HTMLCanvasElement>("stage-canvas");
const framebuffer = byId<HTMLCanvasElement>("screen");
const fileInput = byId<HTMLInputElement>("rom-file");
const chooseRom = byId<HTMLButtonElement>("choose-rom");
const progressTrack = byId<HTMLElement>("progress-track");
const stageStatus = byId<HTMLElement>("stage-status");
const stageHint = byId<HTMLElement>("stage-hint");
const dragOverlay = byId<HTMLElement>("drag-overlay");
const liveStatus = byId<HTMLElement>("live-status");

const mux = new InputMux();
const audio = new BrowserAudio();
let stage: GameBoyStage | null = null;
let stageFailure: Error | null = null;
let runtime: WebRuntime | null = null;
let worker: Worker | null = null;
let detachKeyboard: (() => void) | null = null;
let jobId = 0;
let dragDepth = 0;

const phaseNames: Readonly<Record<string, string>> = {
  verify: "VERIFYING CARTRIDGE",
  extract: "DECODING WORLD",
  atlas: "BUILDING ATLAS",
  map: "VOXELIZING MAPS",
  "ground-bake": "BAKING DIORAMA",
  pack: "PACKING WORLD",
};

function announce(message: string): void {
  liveStatus.textContent = message;
}

function wrapLines(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawScreen(title: string, detail: string, progress?: number): void {
  const context = framebuffer.getContext("2d", { alpha: false });
  if (!context) return;
  const width = framebuffer.width;
  const height = framebuffer.height;
  context.save();
  context.fillStyle = "#08141d";
  context.fillRect(0, 0, width, height);
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "rgba(75, 229, 187, .13)");
  gradient.addColorStop(0.62, "rgba(32, 94, 112, .06)");
  gradient.addColorStop(1, "rgba(255, 85, 119, .12)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#71f0c3";
  context.fillRect(24, 20, 34, 5);
  context.fillStyle = "#d9edf2";
  context.font = "700 13px ui-monospace, SFMono-Regular, monospace";
  context.letterSpacing = "2px";
  context.fillText("POCKET VOXEL / CARTRIDGE BAY", 24, 48);
  context.font = "800 31px ui-monospace, SFMono-Regular, monospace";
  context.letterSpacing = "0px";
  context.fillText(title, 24, 102);
  context.fillStyle = "#89a6b3";
  context.font = "500 16px ui-monospace, SFMono-Regular, monospace";
  let y = 134;
  for (const line of wrapLines(context, detail, width - 48).slice(0, 3)) {
    context.fillText(line, 24, y);
    y += 22;
  }
  if (progress !== undefined) {
    const clean = Math.max(0, Math.min(1, progress));
    context.fillStyle = "#19313c";
    context.fillRect(24, 205, width - 48, 12);
    context.fillStyle = "#71f0c3";
    context.fillRect(24, 205, Math.round((width - 48) * clean), 12);
    context.fillStyle = "#d9edf2";
    context.font = "700 14px ui-monospace, SFMono-Regular, monospace";
    context.fillText(`${Math.round(clean * 100)}%`, width - 62, 241);
  } else {
    context.fillStyle = "#ff5577";
    context.fillRect(24, 225, 8, 8);
    context.fillStyle = "#6f8a96";
    context.font = "600 12px ui-monospace, SFMono-Regular, monospace";
    context.fillText("CLICK LCD OR DROP A 1 MiB ROM", 42, 233);
  }
  context.globalAlpha = 0.08;
  context.fillStyle = "#ffffff";
  for (let scan = 1; scan < height; scan += 4) context.fillRect(0, scan, width, 1);
  context.restore();
  stage?.blit();
}

function updateStageCopy(status: string, hint: string): void {
  stageStatus.textContent = status;
  stageHint.textContent = hint;
}

function resetRuntime(): void {
  runtime?.stop();
  runtime = null;
  detachKeyboard?.();
  detachKeyboard = null;
  mux.clear();
  stage?.setRuntimeReady(false);
}

function showIdle(): void {
  resetRuntime();
  worker?.terminate();
  worker = null;
  stageRoot.dataset.state = "idle";
  stage?.setScreenActionEnabled(true);
  chooseRom.disabled = false;
  chooseRom.querySelector("span")!.textContent = "Insert your ROM";
  progressTrack.setAttribute("aria-valuenow", "0");
  updateStageCopy("READY FOR CARTRIDGE", "Click the LCD or drop a ROM anywhere");
  drawScreen("INSERT ROM", "DROP A CANONICAL US POKEMON RED CARTRIDGE. PROCESSING STAYS ON THIS DEVICE.");
  announce("Choose a ROM to begin.");
}

function updateProgress(phase: string, fraction: number, label: string): void {
  const clean = Math.max(0, Math.min(1, fraction));
  const percent = Math.round(clean * 100);
  const phaseName = phaseNames[phase] ?? phase.toUpperCase();
  stageRoot.dataset.state = "cooking";
  stage?.setScreenActionEnabled(false);
  stage?.setRuntimeReady(false);
  chooseRom.disabled = true;
  chooseRom.querySelector("span")!.textContent = `Baking · ${percent}%`;
  progressTrack.setAttribute("aria-valuenow", String(percent));
  updateStageCopy(`${phaseName} · ${percent}%`, "The cartridge remains inside this browser tab");
  drawScreen(phaseName, label.toUpperCase(), clean);
  announce(`${phaseName}: ${label}, ${percent} percent.`);
}

function showError(message: string, wrongRom: boolean): void {
  worker?.terminate();
  worker = null;
  resetRuntime();
  stageRoot.dataset.state = "error";
  stage?.setScreenActionEnabled(true);
  chooseRom.disabled = false;
  chooseRom.querySelector("span")!.textContent = "Try another ROM";
  const title = wrongRom ? "ROM REJECTED" : "BAKE FAILED";
  const detail = wrongRom
    ? `POCKET VOXEL NEEDS THE CANONICAL 1 MiB US POKEMON RED ROM. ${message}`
    : message;
  updateStageCopy(title, "Click the LCD to choose another cartridge");
  drawScreen(title, detail.toUpperCase());
  announce(`${title}. ${detail}`);
}

function openRomPicker(): void {
  if (chooseRom.disabled || stageFailure) return;
  fileInput.value = "";
  fileInput.click();
}

async function bake(file: File): Promise<void> {
  if (stageFailure) return;
  const thisJob = ++jobId;
  resetRuntime();
  worker?.terminate();
  worker = null;
  if (file.size !== RED_ROM_BYTES) {
    showError(
      `Selected file is ${file.size.toLocaleString()} bytes; expected ${RED_ROM_BYTES.toLocaleString()} bytes.`,
      true,
    );
    return;
  }
  void audio.arm();
  updateProgress("verify", 0, "Reading cartridge");
  try {
    const rom = await file.arrayBuffer();
    if (thisJob !== jobId) return;
    const cookingWorker = new Worker(new URL("./cook.worker.js", import.meta.url), { type: "module" });
    worker = cookingWorker;
    cookingWorker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      if (data.jobId !== jobId) return;
      if (data.type === "progress") {
        updateProgress(data.phase, data.fraction, data.label);
      } else if (data.type === "error") {
        showError(data.message, data.wrongRom);
      } else {
        cookingWorker.terminate();
        if (worker === cookingWorker) worker = null;
        void boot(thisJob, data.pak, data.gameJson, data.elapsedMs, data.pakBytes);
      }
    };
    cookingWorker.onerror = (event) => {
      event.preventDefault();
      if (thisJob === jobId) showError(event.message || "The cooking worker stopped unexpectedly.", false);
    };
    cookingWorker.postMessage({ type: "cook", jobId: thisJob, rom } satisfies WorkerRequest, [rom]);
  } catch (error) {
    if (thisJob === jobId) showError(error instanceof Error ? error.message : String(error), false);
  }
}

function showStageFailure(error: Error): void {
  if (stageFailure) return;
  stageFailure = error;
  jobId += 1;
  worker?.terminate();
  worker = null;
  resetRuntime();
  stageRoot.dataset.state = "error";
  stageRoot.classList.add("has-error");
  chooseRom.disabled = true;
  chooseRom.querySelector("span")!.textContent = "3D unavailable";
  updateStageCopy("3D UNAVAILABLE", error.message);
  announce(`The 3D Game Boy could not be loaded. ${error.message}`);
}

async function boot(
  bootJob: number,
  pak: ArrayBuffer,
  gameJson: ArrayBuffer,
  elapsedMs: number,
  pakBytes: number,
): Promise<void> {
  updateProgress(
    "pack",
    1,
    `${(pakBytes / 1024 / 1024).toFixed(1)} MiB baked in ${(elapsedMs / 1000).toFixed(1)} seconds`,
  );
  let created: WebRuntime | null = null;
  try {
    const activeStage = await stageReady;
    if (!activeStage) throw stageFailure ?? new Error("The 3D Game Boy could not be loaded.");
    created = await WebRuntime.create({
      canvas: framebuffer,
      pak,
      gameJson,
      input: mux,
      audio,
      renderHz: 60,
      onBlit: () => activeStage.blit(),
      onGamepad: (connected) => {
        if (bootJob === jobId) {
          stageHint.textContent = connected
            ? "Gamepad connected · drag the handheld to orbit"
            : "Arrows / WASD · Z / J = A · X / K = B";
        }
      },
      onError: (error) => {
        if (bootJob === jobId) showError(error.message, false);
      },
    });
    if (bootJob !== jobId) {
      created.dispose();
      return;
    }
    runtime = created;
    detachKeyboard = attachKeyboard(activeStage.canvas, mux);
    activeStage.setScreenActionEnabled(false);
    activeStage.setRuntimeReady(true);
    stageRoot.dataset.state = "live";
    chooseRom.disabled = false;
    chooseRom.querySelector("span")!.textContent = "Change cartridge";
    updateStageCopy("LIVE · RUST + WASM", "Arrows / WASD · Z / J = A · X / K = B");
    runtime.start();
    activeStage.canvas.focus();
    announce("Pocket Voxel is running inside the 3D Game Boy.");
  } catch (error) {
    created?.dispose();
    if (bootJob === jobId) showError(error instanceof Error ? error.message : String(error), false);
  }
}

const stageReady: Promise<GameBoyStage | null> = mountGameBoyStage({
  root: stageRoot,
  viewport: stageViewport,
  canvas: stageCanvas,
  framebuffer,
  input: mux,
  onScreenActivate: openRomPicker,
  onError: showStageFailure,
}).then((mounted) => {
  stage = mounted;
  mounted.blit();
  mounted.setScreenActionEnabled(stageRoot.dataset.state !== "cooking" && stageRoot.dataset.state !== "live");
  return mounted;
}).catch((error) => {
  showStageFailure(error instanceof Error ? error : new Error(String(error)));
  return null;
});

chooseRom.addEventListener("click", openRomPicker);
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void bake(file);
});

for (const eventName of ["dragenter", "dragover"] as const) {
  window.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (stageFailure) return;
    if (eventName === "dragenter") dragDepth += 1;
    dragOverlay.classList.add("is-visible");
    stageRoot.classList.add("is-dragging");
  });
}
window.addEventListener("dragleave", (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    dragOverlay.classList.remove("is-visible");
    stageRoot.classList.remove("is-dragging");
  }
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  dragOverlay.classList.remove("is-visible");
  stageRoot.classList.remove("is-dragging");
  const file = stageFailure ? undefined : event.dataTransfer?.files[0];
  if (file) void bake(file);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) runtime?.pause();
  else runtime?.resume();
});
window.addEventListener("blur", () => mux.clear());
window.addEventListener("beforeunload", () => {
  runtime?.stop();
  worker?.terminate();
  stage?.destroy();
  void audio.close();
});

showIdle();
