// End-to-end ABI smoke: instantiate the generated bindings, mount a real
// cooked pak, read its borrowed sections through wasm_memory(), apply scene
// ops, and read both the RGBA framebuffer and PCM buffers by pointer.

import init, {
  PocketVoxel,
  wasm_memory,
} from "../generated/pocketvoxel_wasm.js";

const pakPath = process.argv[2] ?? "dist/voxelmon/voxelmon.vxpak";
const wasmPath = new URL("../generated/pocketvoxel_wasm_bg.wasm", import.meta.url);
const wasmBytes = await Bun.file(wasmPath).arrayBuffer();
await init({ module_or_path: wasmBytes });

const pakFile = Bun.file(pakPath);
if (!(await pakFile.exists())) {
  throw new Error(`Pocket Voxel wasm smoke: no VXPK at ${pakPath}`);
}
const runtime = new PocketVoxel(new Uint8Array(await pakFile.arrayBuffer()));
const memory = wasm_memory() as WebAssembly.Memory;
const bytes = (ptr: number, len: number) => new Uint8Array(memory.buffer, ptr, len);

if (runtime.width() !== 480 || runtime.height() !== 272) {
  throw new Error(`unexpected viewport ${runtime.width()}x${runtime.height()}`);
}

const game = JSON.parse(
  new TextDecoder().decode(bytes(runtime.gamedata_ptr(), runtime.gamedata_len())),
) as { maps?: Record<string, { index: number }> };
const room = game.maps?.REDS_HOUSE_2F;
if (!room) throw new Error("GAME section has no REDS_HOUSE_2F map");

// mapShow(slot=0), then centre the camera on the bedroom spawn (3,6).
runtime.op(10, 4, 0, room.index, 0, 0, 0, 0, 0);
runtime.op(12, 2, (3 * 16 + 8) * 16, (6 * 16 + 8) * 16, 0, 0, 0, 0, 0);
runtime.tick();
const framePtr = runtime.render();
const frameLen = runtime.framebuffer_len();
const frame = bytes(framePtr, frameLen);
if (frame.length !== 480 * 272 * 4) throw new Error(`short framebuffer: ${frame.length}`);
const colors = new Set<number>();
for (let i = 0; i < frame.length; i += 4) {
  colors.add(
    frame[i]! | (frame[i + 1]! << 8) | (frame[i + 2]! << 16) | (frame[i + 3]! << 24),
  );
  if (colors.size >= 8) break;
}
if (colors.size < 8) throw new Error(`flat framebuffer: only ${colors.size} colors`);

const audioLen = runtime.audiodata_len();
const audioBytes = bytes(runtime.audiodata_ptr(), audioLen);
if (audioBytes.length < 16) throw new Error(`short AUDI section: ${audioBytes.length}`);
const pcmPtr = runtime.render_audio(735);
const pcm = new Int16Array(memory.buffer, pcmPtr, runtime.pcm_len());
if (pcm.length !== 1470) throw new Error(`short PCM buffer: ${pcm.length}`);

console.log(
  `Pocket Voxel wasm smoke: ${colors.size}+ colors, ${frameLen} RGBA bytes, ` +
    `${audioLen} AUDI bytes, ${pcm.length / 2} PCM frames`,
);
runtime.free();
