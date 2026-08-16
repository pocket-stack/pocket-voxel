// Assemble both console downloads through the same generated WASM used by the
// browser, then ask the system ZIP reader to validate every entry and CRC.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import init, {
  build_psp_install_zip,
  build_vita_vpk,
} from "../generated/pocketvoxel_packager_wasm.js";

const root = new URL("../..", import.meta.url).pathname;
const bytes = (path: string): Uint8Array => new Uint8Array(readFileSync(join(root, path)));
const wasm = bytes("web/generated/pocketvoxel_packager_wasm_bg.wasm");
await init({ module_or_path: wasm });

const pak = bytes("dist/voxelmon/voxelmon.vxpak");
const notices = bytes("web/platform/THIRD_PARTY_NOTICES.txt");
const startedPsp = performance.now();
const psp = build_psp_install_zip(
  bytes("web/platform/psp/pocketvoxel-psp.prx"),
  bytes("web/platform/psp/ICON0.png"),
  bytes("web/platform/psp/PIC1.png"),
  notices,
  pak,
);
const pspMs = performance.now() - startedPsp;

const startedVita = performance.now();
const vita = build_vita_vpk(
  bytes("web/platform/vita/eboot.bin"),
  bytes("web/platform/vita/sce_sys/param.sfo"),
  bytes("web/platform/vita/sce_sys/icon0.png"),
  bytes("web/platform/vita/sce_sys/livearea/contents/bg.png"),
  bytes("web/platform/vita/sce_sys/livearea/contents/startup.png"),
  bytes("web/platform/vita/sce_sys/livearea/contents/template.xml"),
  notices,
  pak,
);
const vitaMs = performance.now() - startedVita;

const temporary = mkdtempSync(join(tmpdir(), "pocketvoxel-packager-"));
try {
  const pspPath = join(temporary, "PocketVoxel-PSP.zip");
  const vitaPath = join(temporary, "PocketVoxel.vpk");
  await Bun.write(pspPath, psp);
  await Bun.write(vitaPath, vita);

  const run = (command: string[]): string => {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
      throw new Error(`${command.join(" ")} failed:\n${result.stderr.toString()}`);
    }
    return result.stdout.toString();
  };
  run(["unzip", "-t", pspPath]);
  run(["unzip", "-t", vitaPath]);

  const pspNames = run(["unzip", "-Z1", pspPath]).trim().split("\n");
  const vitaNames = run(["unzip", "-Z1", vitaPath]).trim().split("\n");
  const expectedPsp = [
    "PSP/GAME/VOXELMON/EBOOT.PBP",
    "PSP/GAME/VOXELMON/voxelmon.vxpak",
    "PSP/GAME/VOXELMON/THIRD_PARTY_NOTICES.txt",
  ];
  const expectedVita = [
    "sce_sys/param.sfo",
    "eboot.bin",
    "sce_sys/icon0.png",
    "sce_sys/livearea/contents/bg.png",
    "sce_sys/livearea/contents/startup.png",
    "sce_sys/livearea/contents/template.xml",
    "voxelmon.vxpak",
    "THIRD_PARTY_NOTICES.txt",
  ];
  if (JSON.stringify(pspNames) !== JSON.stringify(expectedPsp)) {
    throw new Error(`PSP package paths differ: ${pspNames.join(", ")}`);
  }
  if (JSON.stringify(vitaNames) !== JSON.stringify(expectedVita)) {
    throw new Error(`Vita package paths differ: ${vitaNames.join(", ")}`);
  }

  const extract = (archive: string, path: string): Buffer => {
    const result = Bun.spawnSync(["unzip", "-p", archive, path], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`could not extract ${path}`);
    return result.stdout;
  };
  const expectedPak = Buffer.from(pak);
  const expectedNotices = Buffer.from(notices);
  if (!extract(pspPath, expectedPsp[1]!).equals(expectedPak)) throw new Error("PSP VXPK changed");
  if (!extract(vitaPath, "voxelmon.vxpak").equals(expectedPak)) throw new Error("Vita VXPK changed");
  if (!extract(pspPath, expectedPsp[2]!).equals(expectedNotices)) {
    throw new Error("PSP third-party notices changed");
  }
  if (!extract(vitaPath, "THIRD_PARTY_NOTICES.txt").equals(expectedNotices)) {
    throw new Error("Vita third-party notices changed");
  }
  for (const marker of [
    "QuickJS",
    "rust-psp",
    "PSPSDK",
    "libvita2d",
    "vitasdk-sys",
    "slotmap",
    "Newlib",
    "Unicode License v3",
  ]) {
    if (!expectedNotices.includes(Buffer.from(marker))) {
      throw new Error(`Native notices are missing ${marker}`);
    }
  }
  if (!extract(vitaPath, "eboot.bin").equals(Buffer.from(bytes("web/platform/vita/eboot.bin")))) {
    throw new Error("Vita eboot template changed");
  }

  const pbp = extract(pspPath, expectedPsp[0]!);
  if (!pbp.subarray(0, 4).equals(Buffer.from([0, 0x50, 0x42, 0x50]))) {
    throw new Error("PSP EBOOT has no PBP magic");
  }
  const dataPsp = pbp.readUInt32LE(32);
  const dataPsar = pbp.readUInt32LE(36);
  if (dataPsp >= dataPsar || dataPsar !== pbp.length) throw new Error("PSP PBP offsets are invalid");
  if (!pbp.subarray(40, 44).equals(Buffer.from([0, 0x50, 0x53, 0x46]))) {
    throw new Error("PSP EBOOT has no PARAM.SFO");
  }
  if (!pbp.includes(Buffer.from("MEMSIZE\0")) || !pbp.includes(Buffer.from("PVXL00001\0"))) {
    throw new Error("PSP PARAM.SFO is missing its memory/title contract");
  }

  const packPbp = Bun.which("pack-pbp");
  if (packPbp) {
    const sfoPath = join(temporary, "PARAM.SFO");
    const nativePbp = join(temporary, "native.EBOOT.PBP");
    const iconOffset = pbp.readUInt32LE(12);
    await Bun.write(sfoPath, pbp.subarray(40, iconOffset));
    const packed = Bun.spawnSync([
      packPbp,
      nativePbp,
      sfoPath,
      join(root, "web/platform/psp/ICON0.png"),
      "NULL",
      "NULL",
      join(root, "web/platform/psp/PIC1.png"),
      "NULL",
      join(root, "web/platform/psp/pocketvoxel-psp.prx"),
      "NULL",
    ], { stdout: "pipe", stderr: "pipe" });
    if (packed.exitCode !== 0) throw new Error(`pack-pbp parity failed: ${packed.stderr.toString()}`);
    if (!readFileSync(nativePbp).equals(pbp)) throw new Error("WASM PBP differs from pack-pbp");
  }

  if (psp.byteLength >= 12 * 1024 * 1024 || vita.byteLength >= 12 * 1024 * 1024) {
    throw new Error("console package unexpectedly lost compression");
  }
  console.log(
    `Pocket Voxel packager: PSP ${(psp.byteLength / 1024 / 1024).toFixed(1)} MiB / ` +
      `${pspMs.toFixed(0)} ms; Vita ${(vita.byteLength / 1024 / 1024).toFixed(1)} MiB / ` +
      `${vitaMs.toFixed(0)} ms; archives, PBP${packPbp ? " parity, " : ", "}and embedded VXPK verified`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
