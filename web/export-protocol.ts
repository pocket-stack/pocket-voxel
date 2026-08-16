export type NativeTarget = "psp" | "vita";

export interface ExportRequest {
  type: "build";
  jobId: number;
  target: NativeTarget;
  pak: ArrayBuffer;
}

export interface ExportProgressMessage {
  type: "progress";
  jobId: number;
  target: NativeTarget;
  fraction: number;
  label: string;
}

export interface ExportReadyMessage {
  type: "ready";
  jobId: number;
  target: NativeTarget;
  artifact: ArrayBuffer;
  filename: string;
  mime: string;
  bytes: number;
  elapsedMs: number;
}

export interface ExportErrorMessage {
  type: "error";
  jobId: number;
  target: NativeTarget;
  message: string;
}

export type ExportWorkerMessage =
  | ExportProgressMessage
  | ExportReadyMessage
  | ExportErrorMessage;
