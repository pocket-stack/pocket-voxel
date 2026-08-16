/// <reference lib="webworker" />

import type { Profile } from "../voxelmon/cook/data.ts";
import { cookVoxelPak } from "../voxelmon/cook/core.ts";
import type { RedppPack } from "../voxelmon/cook/redpp.ts";
import { importRedRom } from "../voxelmon/import/core.ts";
import type { Manifest } from "../voxelmon/import/manifest.ts";
import palettesGbc from "./reference/palettes-gbc.json";
import romManifest from "./reference/rom-manifest.json";
import voxelProfile from "./reference/voxel-profile.json";
import {
  errorMessage,
  isWrongRomError,
  progressFraction,
  type PipelinePhase,
  type WorkerMessage,
  type WorkerRequest,
} from "./protocol.ts";

const worker = self as unknown as DedicatedWorkerGlobalScope;

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer;
}

function progress(
  jobId: number,
  phase: PipelinePhase,
  completed: number,
  total: number,
  label: string,
): void {
  const message: WorkerMessage = {
    type: "progress",
    jobId,
    phase,
    completed,
    total,
    label,
    fraction: progressFraction(phase, completed, total),
  };
  worker.postMessage(message);
}

worker.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type !== "cook") return;
  const { jobId } = data;
  const started = performance.now();
  try {
    const imported = await importRedRom(
      new Uint8Array(data.rom),
      romManifest as unknown as Manifest,
      (event) => progress(jobId, event.phase, event.completed, event.total, event.label),
    );
    const cooked = cookVoxelPak(
      {
        gen: imported.gen,
        profile: voxelProfile as unknown as Profile,
        redpp: palettesGbc as unknown as RedppPack,
        audioJson: imported.audioJson,
        audioPrograms: imported.audioPrograms,
      },
      (event) => progress(jobId, event.phase, event.completed, event.total, event.label),
    );
    const pak = exactBuffer(cooked.pak);
    const gameJson = exactBuffer(cooked.gameJson);
    const message: WorkerMessage = {
      type: "cooked",
      jobId,
      pak,
      gameJson,
      elapsedMs: performance.now() - started,
      pakBytes: cooked.pakBytes,
    };
    worker.postMessage(message, [pak, gameJson]);
  } catch (error) {
    const message = errorMessage(error);
    worker.postMessage({
      type: "error",
      jobId,
      message,
      wrongRom: isWrongRomError(message),
    } satisfies WorkerMessage);
  }
};
