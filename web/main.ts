import { RED_ROM_BYTES } from "../voxelmon/import/constants.ts";
import { BrowserAudio } from "./audio.ts";
import type { ExportRequest, ExportWorkerMessage, NativeTarget } from "./export-protocol.ts";
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
const helpOpen = byId<HTMLButtonElement>("help-open");
const helpDialog = byId<HTMLDialogElement>("help-dialog");
const creditsOpen = byId<HTMLButtonElement>("credits-open");
const creditsDialog = byId<HTMLDialogElement>("credits-dialog");
const rotationToggle = byId<HTMLInputElement>("rotation-toggle");
const mobileTools = byId<HTMLElement>("mobile-tools");
const mobileToolsToggle = byId<HTMLButtonElement>("mobile-tools-toggle");
const mobileToolsPanel = byId<HTMLElement>("mobile-tools-panel");
const nativeTargetOptions = byId<HTMLFieldSetElement>("native-target-options");
const targetResult = byId<HTMLElement>("target-result");
const targetResultCopy = byId<HTMLElement>("target-result-copy");
const targetAction = byId<HTMLButtonElement>("target-action");
const modeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')];
const nativeTargetInputs = [
  ...document.querySelectorAll<HTMLInputElement>('input[name="native-target"]'),
];
const mobileToolsMedia = window.matchMedia("(max-width: 780px)");
if (modeInputs.length !== 2 || nativeTargetInputs.length !== 2) {
  throw new Error("Missing Web/Homebrew mode options");
}

const ROTATION_PREFERENCE_KEY = "pocket-voxel:rotation-enabled";

function readRotationPreference(): boolean {
  try {
    const stored = window.localStorage.getItem(ROTATION_PREFERENCE_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    // Storage may be unavailable in a private or sandboxed browsing context.
  }
  return true;
}

function writeRotationPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(ROTATION_PREFERENCE_KEY, String(enabled));
  } catch {
    // Rotation still works for this tab when storage is unavailable.
  }
}

rotationToggle.checked = readRotationPreference();

function setMobileToolsOpen(open: boolean, returnFocus = false): void {
  mobileTools.classList.toggle("is-open", open);
  mobileToolsToggle.setAttribute("aria-expanded", String(open));
  mobileToolsToggle.setAttribute("aria-label", open ? "Close page menu" : "Open page menu");
  if (!open && returnFocus) mobileToolsToggle.focus();
}

function closeMobileTools(returnFocus = false): void {
  setMobileToolsOpen(false, returnFocus);
}

type BuildTarget = "web" | NativeTarget;
type AppMode = "web" | "homebrew";

interface CookedArtifacts {
  pak: ArrayBuffer;
  gameJson: ArrayBuffer;
  elapsedMs: number;
  pakBytes: number;
}

interface NativeOutputState {
  status: "idle" | "building" | "ready" | "error";
  detail: string;
  url?: string;
  filename?: string;
  bytes?: number;
}

const mux = new InputMux();
const audio = new BrowserAudio();
let stage: GameBoyStage | null = null;
let stageFailure: Error | null = null;
let runtime: WebRuntime | null = null;
let worker: Worker | null = null;
let exportWorker: Worker | null = null;
let detachKeyboard: (() => void) | null = null;
let cooked: CookedArtifacts | null = null;
let exportingTarget: NativeTarget | null = null;
let webBuilding = false;
let webError = "";
let jobId = 0;
let dragDepth = 0;
let targetOptionsLocked = false;
const nativeOutputs: Record<NativeTarget, NativeOutputState> = {
  psp: { status: "idle", detail: "" },
  vita: { status: "idle", detail: "" },
};

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
  const canvasWidth = framebuffer.width;
  const canvasHeight = framebuffer.height;
  const screenWidth = 160;
  const screenHeight = 144;
  const scale = canvasHeight / screenHeight;
  const originX = (canvasWidth - screenWidth * scale) / 2;
  context.save();
  context.fillStyle = "#08141d";
  context.fillRect(0, 0, canvasWidth, canvasHeight);
  context.translate(originX, 0);
  context.scale(scale, scale);
  const gradient = context.createLinearGradient(0, 0, screenWidth, screenHeight);
  gradient.addColorStop(0, "rgba(75, 229, 187, .13)");
  gradient.addColorStop(0.62, "rgba(32, 94, 112, .06)");
  gradient.addColorStop(1, "rgba(255, 85, 119, .12)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, screenWidth, screenHeight);
  context.fillStyle = "#71f0c3";
  context.fillRect(8, 8, 18, 3);
  context.fillStyle = "#d9edf2";
  context.font = "700 6px ui-monospace, SFMono-Regular, monospace";
  context.letterSpacing = "1px";
  context.fillText("POCKET VOXEL", 8, 22);
  context.font = "800 12px ui-monospace, SFMono-Regular, monospace";
  context.letterSpacing = "0px";
  context.fillText(title, 8, 52);
  context.fillStyle = "#89a6b3";
  context.font = "500 6.5px ui-monospace, SFMono-Regular, monospace";
  let y = 68;
  for (const line of wrapLines(context, detail, screenWidth - 16).slice(0, 4)) {
    context.fillText(line, 8, y);
    y += 9;
  }
  if (progress !== undefined) {
    const clean = Math.max(0, Math.min(1, progress));
    context.fillStyle = "#19313c";
    context.fillRect(8, 114, screenWidth - 16, 6);
    context.fillStyle = "#71f0c3";
    context.fillRect(8, 114, Math.round((screenWidth - 16) * clean), 6);
    context.fillStyle = "#d9edf2";
    context.font = "700 7px ui-monospace, SFMono-Regular, monospace";
    context.fillText(`${Math.round(clean * 100)}%`, screenWidth - 28, 135);
  }
  context.globalAlpha = 0.08;
  context.fillStyle = "#ffffff";
  for (let scan = 1; scan < screenHeight; scan += 2) context.fillRect(0, scan, screenWidth, 0.5);
  context.restore();
  stage?.blit();
}

function syncRuntimeActivity(): void {
  if (!runtime) return;
  if (
    document.hidden ||
    helpDialog.open ||
    creditsDialog.open ||
    selectedMode() !== "web"
  ) runtime.pause();
  else runtime.resume();
}

function openDialog(dialog: HTMLDialogElement): void {
  if (dialog.open) return;
  closeMobileTools();
  const other = dialog === helpDialog ? creditsDialog : helpDialog;
  if (other.open) other.close();
  mux.clear();
  stage?.releaseInput();
  dialog.showModal();
  syncRuntimeActivity();
}

function updateStageCopy(status: string, hint: string): void {
  stageStatus.textContent = status;
  stageHint.textContent = hint;
}

function syncRotationControl(announceChange = false): void {
  const enabled = rotationToggle.checked && !rotationToggle.disabled;
  stage?.setRotationEnabled(enabled);
  if (stageFailure) {
    stageCanvas.setAttribute(
      "aria-label",
      "3D Game Boy unavailable. Choose Homebrew mode to build for PSP or PS Vita.",
    );
    return;
  }
  stageCanvas.setAttribute(
    "aria-label",
    enabled
      ? "Interactive 3D Game Boy. Drag empty space to rotate; use its controls, keyboard, or gamepad to play."
      : "Interactive 3D Game Boy with rotation locked. Use its controls, keyboard, or gamepad to play.",
  );
  if (announceChange) announce(`Game Boy model rotation ${enabled ? "on" : "off"}.`);
}

function selectedMode(): AppMode {
  const value = modeInputs.find((input) => input.checked)?.value;
  if (value === "web" || value === "homebrew") return value;
  throw new Error("Choose Web or Homebrew mode");
}

function selectedNativeTarget(): NativeTarget {
  const value = nativeTargetInputs.find((input) => input.checked)?.value;
  if (value === "psp" || value === "vita") return value;
  throw new Error("Choose a Homebrew platform");
}

function selectedTarget(): BuildTarget {
  return selectedMode() === "web" ? "web" : selectedNativeTarget();
}

function targetLabel(target: BuildTarget): string {
  if (target === "web") return "Web Player";
  if (target === "psp") return "PSP package";
  return "PS Vita VPK";
}

function sizeLabel(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function nativeTargetInput(target: NativeTarget): HTMLInputElement {
  const input = nativeTargetInputs.find((candidate) => candidate.value === target);
  if (!input) throw new Error(`Missing ${target} build target`);
  return input;
}

function setTargetOptionsDisabled(disabled: boolean): void {
  targetOptionsLocked = disabled;
  for (const input of modeInputs) {
    input.disabled = disabled || (input.value === "web" && stageFailure !== null);
  }
  const nativeDisabled = disabled || selectedMode() !== "homebrew";
  nativeTargetOptions.disabled = nativeDisabled;
  for (const input of nativeTargetInputs) input.disabled = nativeDisabled;
}

function syncModeUi(): void {
  const mode = selectedMode();
  nativeTargetOptions.hidden = mode !== "homebrew";
  document.body.dataset.mode = mode;
  if (mode === "homebrew") {
    mux.clear();
    stage?.releaseInput();
  }
  setTargetOptionsDisabled(targetOptionsLocked);
  syncRuntimeActivity();
  syncTargetResult();
}

function clearNativeOutputs(): void {
  exportWorker?.terminate();
  exportWorker = null;
  exportingTarget = null;
  for (const target of ["psp", "vita"] as const) {
    const output = nativeOutputs[target];
    if (output.url) URL.revokeObjectURL(output.url);
    nativeOutputs[target] = { status: "idle", detail: "" };
  }
}

function clearCookedArtifacts(): void {
  clearNativeOutputs();
  cooked = null;
  webBuilding = false;
  webError = "";
  targetResult.hidden = true;
}

function syncTargetResult(): void {
  if (!cooked) {
    targetResult.hidden = true;
    return;
  }
  const target = selectedTarget();
  if (target === "web" && runtime) {
    targetResult.hidden = true;
    targetResultCopy.textContent = "";
    targetAction.textContent = "";
    return;
  }
  targetResult.hidden = false;
  targetAction.hidden = false;
  targetAction.disabled = false;
  if (target === "web") {
    if (webBuilding) {
      targetResultCopy.textContent = "Starting the Web Player from the cooked world…";
      targetAction.textContent = "Starting…";
      targetAction.disabled = true;
    } else if (stageFailure) {
      targetResultCopy.textContent = `Web Player unavailable: ${stageFailure.message}`;
      targetAction.textContent = "3D unavailable";
      targetAction.disabled = true;
    } else {
      targetResultCopy.textContent = webError
        ? `Web Player failed: ${webError}`
        : "The cooked world is ready for the Web Player.";
      targetAction.textContent = webError ? "Retry Web Player" : "Launch Web Player";
    }
    return;
  }

  const output = nativeOutputs[target];
  const name = target === "psp" ? "PSP install ZIP" : "PS Vita VPK";
  if (output.status === "building") {
    targetResultCopy.textContent = output.detail;
    targetAction.textContent = `Building ${name}…`;
    targetAction.disabled = true;
  } else if (output.status === "ready") {
    targetResultCopy.textContent = `${name} ready · ${sizeLabel(output.bytes ?? 0)} · ${output.detail}`;
    targetAction.textContent = target === "psp" ? "Download PSP ZIP" : "Download VPK";
  } else if (output.status === "error") {
    targetResultCopy.textContent = `${name} failed: ${output.detail}`;
    targetAction.textContent = `Retry ${name}`;
  } else if (exportingTarget) {
    targetResultCopy.textContent = `${targetLabel(exportingTarget)} is building; this target can follow without recooking.`;
    targetAction.textContent = "Another package is building";
    targetAction.disabled = true;
  } else {
    targetResultCopy.textContent = `The same cooked world can now be assembled as a ${name}.`;
    targetAction.textContent = `Build ${name}`;
  }
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
  clearCookedArtifacts();
  worker?.terminate();
  worker = null;
  stageRoot.dataset.state = "idle";
  stage?.setScreenActionEnabled(true);
  chooseRom.disabled = false;
  setTargetOptionsDisabled(false);
  chooseRom.querySelector("span")!.textContent = "Choose ROM";
  progressTrack.setAttribute("aria-valuenow", "0");
  progressTrack.removeAttribute("aria-valuetext");
  updateStageCopy("INSERT CARTRIDGE", "Choose or drop a Pokémon Red ROM");
  drawScreen("INSERT CARTRIDGE", "");
  announce("Choose a ROM to begin.");
}

function updateProgress(phase: string, fraction: number, label: string): void {
  const clean = Math.max(0, Math.min(1, fraction));
  const percent = Math.round(clean * 100);
  const phaseName = phaseNames[phase] ?? phase.toUpperCase();
  if (!stageFailure) {
    stageRoot.dataset.state = "cooking";
    stage?.setScreenActionEnabled(false);
    stage?.setRuntimeReady(false);
    updateStageCopy(`${phaseName} · ${percent}%`, "The cartridge remains inside this browser tab");
    drawScreen(phaseName, label.toUpperCase(), clean);
  }
  chooseRom.disabled = true;
  setTargetOptionsDisabled(true);
  chooseRom.querySelector("span")!.textContent = `Baking · ${percent}%`;
  progressTrack.setAttribute("aria-valuenow", String(percent));
  progressTrack.removeAttribute("aria-valuetext");
  announce(`${phaseName}: ${label}, ${percent} percent.`);
}

function showError(message: string, wrongRom: boolean): void {
  worker?.terminate();
  worker = null;
  resetRuntime();
  clearCookedArtifacts();
  stageRoot.dataset.state = "error";
  stage?.setScreenActionEnabled(true);
  chooseRom.disabled = false;
  setTargetOptionsDisabled(false);
  chooseRom.querySelector("span")!.textContent = "Try another ROM";
  const title = wrongRom ? "ROM REJECTED" : "BAKE FAILED";
  const detail = wrongRom
    ? `POCKET VOXEL NEEDS THE CANONICAL 1 MiB US POKEMON RED ROM. ${message}`
    : message;
  progressTrack.setAttribute("aria-valuenow", "0");
  progressTrack.setAttribute("aria-valuetext", `${title}: ${detail}`);
  updateStageCopy(title, "Click the LCD to choose another cartridge");
  drawScreen(title, detail.toUpperCase());
  announce(`${title}. ${detail}`);
}

function openRomPicker(): void {
  if (chooseRom.disabled) return;
  fileInput.value = "";
  fileInput.click();
}

async function bake(file: File): Promise<void> {
  const thisJob = ++jobId;
  resetRuntime();
  clearCookedArtifacts();
  worker?.terminate();
  worker = null;
  if (file.size !== RED_ROM_BYTES) {
    showError(
      `Selected file is ${file.size.toLocaleString()} bytes; expected ${RED_ROM_BYTES.toLocaleString()} bytes.`,
      true,
    );
    return;
  }
  if (selectedTarget() === "web") void audio.arm();
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
        cooked = {
          pak: data.pak,
          gameJson: data.gameJson,
          elapsedMs: data.elapsedMs,
          pakBytes: data.pakBytes,
        };
        chooseRom.disabled = false;
        chooseRom.querySelector("span")!.textContent = "Change cartridge";
        setTargetOptionsDisabled(false);
        updateProgress(
          "pack",
          1,
          `${sizeLabel(data.pakBytes)} baked in ${(data.elapsedMs / 1000).toFixed(1)} seconds`,
        );
        chooseRom.disabled = false;
        chooseRom.querySelector("span")!.textContent = "Change cartridge";
        setTargetOptionsDisabled(false);
        if (!stageFailure) {
          stageRoot.dataset.state = "ready";
          stage?.setScreenActionEnabled(true);
          updateStageCopy("WORLD BAKED", "Choose a target or change the cartridge");
        }
        syncTargetResult();
        void prepareTarget(selectedTarget(), thisJob);
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
  resetRuntime();
  stageRoot.dataset.state = "error";
  stageRoot.classList.add("has-error");
  stageCanvas.tabIndex = -1;
  stageCanvas.setAttribute("aria-disabled", "true");
  stageCanvas.setAttribute(
    "aria-label",
    "3D Game Boy unavailable. Choose Homebrew mode to build for PSP or PS Vita.",
  );
  const fallbackTarget: NativeTarget = "psp";
  const webMode = modeInputs.find((input) => input.value === "web");
  const homebrewMode = modeInputs.find((input) => input.value === "homebrew");
  if (!webMode || !homebrewMode) throw new Error("Missing fallback mode controls");
  webMode.disabled = true;
  if (webMode.checked) homebrewMode.checked = true;
  nativeTargetInput(fallbackTarget).checked = true;
  rotationToggle.checked = false;
  rotationToggle.disabled = true;
  syncModeUi();
  syncRotationControl();
  updateStageCopy("3D UNAVAILABLE", error.message);
  syncTargetResult();
  if (cooked && selectedTarget() === fallbackTarget) void prepareTarget(fallbackTarget, jobId);
  announce(`The 3D Game Boy could not be loaded, but PSP and Vita exports remain available. ${error.message}`);
}

function showWebError(message: string): void {
  resetRuntime();
  webBuilding = false;
  webError = message;
  if (!stageFailure) {
    stageRoot.dataset.state = "error";
    stage?.setScreenActionEnabled(true);
    drawScreen("PLAYER FAILED", message.toUpperCase());
  }
  syncTargetResult();
  announce(`Web Player failed. ${message}`);
}

function finishExportWorker(active: Worker): void {
  active.terminate();
  if (exportWorker === active) exportWorker = null;
  exportingTarget = null;
}

function buildNative(target: NativeTarget, buildJob: number): void {
  if (!cooked || buildJob !== jobId || exportWorker) return;
  const state = nativeOutputs[target];
  if (state.url) URL.revokeObjectURL(state.url);
  nativeOutputs[target] = { status: "building", detail: `Loading ${targetLabel(target)} templates…` };
  exportingTarget = target;
  syncTargetResult();

  const active = new Worker(new URL("./export.worker.js", import.meta.url), { type: "module" });
  exportWorker = active;
  active.onmessage = ({ data }: MessageEvent<ExportWorkerMessage>) => {
    if (data.jobId !== jobId || data.target !== target) return;
    if (data.type === "progress") {
      nativeOutputs[target] = {
        status: "building",
        detail: `${data.label} · ${Math.round(data.fraction * 100)}%`,
      };
      syncTargetResult();
      return;
    }
    finishExportWorker(active);
    if (data.type === "error") {
      nativeOutputs[target] = { status: "error", detail: data.message };
      syncTargetResult();
      announce(`${targetLabel(target)} build failed. ${data.message}`);
      return;
    }
    const blob = new Blob([data.artifact], { type: data.mime });
    nativeOutputs[target] = {
      status: "ready",
      detail: `built locally in ${(data.elapsedMs / 1000).toFixed(1)} seconds`,
      url: URL.createObjectURL(blob),
      filename: data.filename,
      bytes: data.bytes,
    };
    syncTargetResult();
    announce(`${targetLabel(target)} is ready to download.`);
  };
  active.onerror = (event) => {
    event.preventDefault();
    if (buildJob !== jobId || exportWorker !== active) return;
    finishExportWorker(active);
    const message = event.message || "The package worker stopped unexpectedly.";
    nativeOutputs[target] = { status: "error", detail: message };
    syncTargetResult();
    announce(`${targetLabel(target)} build failed. ${message}`);
  };

  try {
    const pak = cooked.pak.slice(0);
    active.postMessage({ type: "build", jobId: buildJob, target, pak } satisfies ExportRequest, [pak]);
  } catch (error) {
    finishExportWorker(active);
    const message = error instanceof Error ? error.message : String(error);
    nativeOutputs[target] = {
      status: "error",
      detail: message,
    };
    syncTargetResult();
    announce(`${targetLabel(target)} build failed. ${message}`);
  }
}

async function prepareTarget(target: BuildTarget, targetJob: number): Promise<void> {
  if (!cooked || targetJob !== jobId) return;
  if (target === "web") {
    if (runtime) {
      syncTargetResult();
      return;
    }
    await boot(targetJob, cooked.pak, cooked.gameJson);
  } else if (nativeOutputs[target].status !== "ready") {
    buildNative(target, targetJob);
  }
}

function downloadOutput(target: NativeTarget): void {
  const output = nativeOutputs[target];
  if (!output.url || !output.filename) return;
  const link = document.createElement("a");
  link.href = output.url;
  link.download = output.filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  announce(`Downloading ${output.filename}.`);
}

function activateSelectedTarget(): void {
  if (!cooked) return;
  const target = selectedTarget();
  if (target === "web") {
    void audio.arm();
    void prepareTarget(target, jobId);
    return;
  }
  if (nativeOutputs[target].status === "ready") downloadOutput(target);
  else buildNative(target, jobId);
}

async function boot(bootJob: number, pak: ArrayBuffer, gameJson: ArrayBuffer): Promise<void> {
  webBuilding = true;
  webError = "";
  syncTargetResult();
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
            ? "Gamepad connected · open Help for controls"
            : "Open Help for controls";
        }
      },
      onError: (error) => {
        if (bootJob === jobId) showWebError(error.message);
      },
    });
    if (bootJob !== jobId || selectedMode() !== "web") {
      created.dispose();
      webBuilding = false;
      syncTargetResult();
      return;
    }
    runtime = created;
    webBuilding = false;
    detachKeyboard = attachKeyboard(activeStage.canvas, mux);
    activeStage.setScreenActionEnabled(false);
    activeStage.setRuntimeReady(true);
    stageRoot.dataset.state = "live";
    chooseRom.disabled = false;
    chooseRom.querySelector("span")!.textContent = "Change cartridge";
    updateStageCopy("PLAYING", "Open Help for controls");
    runtime.start();
    syncRuntimeActivity();
    syncTargetResult();
    if (!helpDialog.open && !creditsDialog.open && selectedMode() === "web") activeStage.canvas.focus();
    announce("Pocket Voxel is running inside the 3D Game Boy.");
  } catch (error) {
    created?.dispose();
    if (bootJob === jobId) showWebError(error instanceof Error ? error.message : String(error));
  }
}

const stageReady: Promise<GameBoyStage | null> = mountGameBoyStage({
  root: stageRoot,
  viewport: stageViewport,
  canvas: stageCanvas,
  framebuffer,
  input: mux,
  initialRotationEnabled: rotationToggle.checked,
  onScreenActivate: openRomPicker,
  onError: showStageFailure,
}).then((mounted) => {
  stage = mounted;
  syncRotationControl();
  mounted.blit();
  mounted.setScreenActionEnabled(stageRoot.dataset.state !== "cooking" && stageRoot.dataset.state !== "live");
  return mounted;
}).catch((error) => {
  showStageFailure(error instanceof Error ? error : new Error(String(error)));
  return null;
});

chooseRom.addEventListener("click", openRomPicker);
targetAction.addEventListener("click", activateSelectedTarget);
for (const input of modeInputs) input.addEventListener("change", syncModeUi);
for (const input of nativeTargetInputs) input.addEventListener("change", syncTargetResult);
rotationToggle.addEventListener("change", () => {
  writeRotationPreference(rotationToggle.checked);
  syncRotationControl(true);
});
mobileToolsToggle.addEventListener("click", () => {
  setMobileToolsOpen(!mobileTools.classList.contains("is-open"));
});
mobileToolsPanel.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("a")) closeMobileTools();
});
mobileTools.addEventListener("focusout", () => {
  queueMicrotask(() => {
    if (mobileTools.classList.contains("is-open") && !mobileTools.contains(document.activeElement)) {
      closeMobileTools();
    }
  });
});
mobileToolsMedia.addEventListener("change", (event) => {
  if (!event.matches) closeMobileTools();
});
document.addEventListener("pointerdown", (event) => {
  if (mobileTools.classList.contains("is-open") && !mobileTools.contains(event.target as Node)) {
    closeMobileTools();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && mobileTools.classList.contains("is-open")) {
    event.preventDefault();
    closeMobileTools(true);
  }
});

function bindDialog(
  opener: HTMLButtonElement,
  dialog: HTMLDialogElement,
): void {
  opener.addEventListener("click", () => openDialog(dialog));
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    syncRuntimeActivity();
    (mobileToolsMedia.matches ? mobileToolsToggle : opener).focus();
  });
}

bindDialog(helpOpen, helpDialog);
bindDialog(creditsOpen, creditsDialog);
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void bake(file);
});

for (const eventName of ["dragenter", "dragover"] as const) {
  window.addEventListener(eventName, (event) => {
    event.preventDefault();
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
  const file = event.dataTransfer?.files[0];
  if (file) void bake(file);
});
document.addEventListener("visibilitychange", syncRuntimeActivity);
window.addEventListener("blur", () => mux.clear());
window.addEventListener("beforeunload", () => {
  runtime?.stop();
  worker?.terminate();
  clearNativeOutputs();
  stage?.destroy();
  void audio.close();
});

syncModeUi();
syncRotationControl();
showIdle();
