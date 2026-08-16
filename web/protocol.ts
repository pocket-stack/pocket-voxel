export type PipelinePhase =
  | "verify"
  | "extract"
  | "atlas"
  | "map"
  | "ground-bake"
  | "pack";

export interface CookRequest {
  type: "cook";
  jobId: number;
  rom: ArrayBuffer;
}

export interface ProgressMessage {
  type: "progress";
  jobId: number;
  phase: PipelinePhase;
  completed: number;
  total: number;
  label: string;
  fraction: number;
}

export interface CookedMessage {
  type: "cooked";
  jobId: number;
  pak: ArrayBuffer;
  gameJson: ArrayBuffer;
  elapsedMs: number;
  pakBytes: number;
}

export interface PipelineErrorMessage {
  type: "error";
  jobId: number;
  message: string;
  wrongRom: boolean;
}

export type WorkerRequest = CookRequest;
export type WorkerMessage = ProgressMessage | CookedMessage | PipelineErrorMessage;

const PHASE_WINDOWS: Record<PipelinePhase, readonly [number, number]> = {
  verify: [0, 0.03],
  extract: [0.03, 0.3],
  atlas: [0.3, 0.4],
  map: [0.4, 0.7],
  "ground-bake": [0.7, 0.93],
  pack: [0.93, 1],
};

export function progressFraction(
  phase: PipelinePhase,
  completed: number,
  total: number,
): number {
  const [start, end] = PHASE_WINDOWS[phase];
  const within = total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0;
  return start + (end - start) * within;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function isWrongRomError(message: string): boolean {
  // These are the importer's exact user-input failures. In particular, do not
  // blame the cartridge for Web Crypto being unavailable or for our static
  // reference manifest being corrupt.
  const exact = message.trim();
  return (
    /^ROM size mismatch: got \d+ bytes, need 1048576$/i.test(exact) ||
    /^ROM SHA-1 mismatch: got [0-9a-f]{40}, need Red [0-9a-f]{40}$/i.test(exact)
  );
}
