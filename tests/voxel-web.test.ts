import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { FixedClock } from "../web/clock.ts";
import { InputMux, standardGamepadMask } from "../web/input.ts";
import { isWrongRomError, progressFraction } from "../web/protocol.ts";

type GlbJson = {
  materials?: {
    name?: string;
    extras?: Record<string, unknown>;
    pbrMetallicRoughness?: { baseColorTexture?: unknown };
  }[];
  meshes?: { primitives?: {
    material?: number;
    attributes?: { POSITION?: number; TEXCOORD_0?: number };
  }[] }[];
  accessors?: { min?: number[]; max?: number[] }[];
};

function decodeGlbJson(bytes: Uint8Array): GlbJson {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(0x46546c67);
  expect(view.getUint32(4, true)).toBe(2);
  expect(view.getUint32(8, true)).toBe(bytes.byteLength);
  const jsonBytes = view.getUint32(12, true);
  expect(view.getUint32(16, true)).toBe(0x4e4f534a);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonBytes)).trim()) as GlbJson;
}

function gamepad(options: {
  axes?: number[];
  buttons?: number[];
  index?: number;
} = {}): Gamepad {
  const down = new Set(options.buttons ?? []);
  return {
    axes: options.axes ?? [0, 0],
    buttons: Array.from({ length: 16 }, (_, index) => ({
      pressed: down.has(index),
      touched: down.has(index),
      value: down.has(index) ? 1 : 0,
    })),
    connected: true,
    id: "test pad",
    index: options.index ?? 0,
    mapping: "standard",
    timestamp: 1,
    vibrationActuator: null,
    hapticActuators: [],
  } as unknown as Gamepad;
}

describe("Pocket Voxel web input", () => {
  test("separate sources cannot release one another", () => {
    const input = new InputMux();
    input.set("key:ArrowUp", "up", true);
    input.set("pointer:1", "up", true);
    input.set("key:KeyZ", "a", true);
    expect(input.mask).toBe(VOX_BTN.up | VOX_BTN.a);
    input.clearSource("pointer:1");
    expect(input.mask).toBe(VOX_BTN.up | VOX_BTN.a);
    input.clearPrefix("key:");
    expect(input.mask).toBe(0);
  });

  test("standard gamepad maps d-pad, face, system and stick", () => {
    expect(standardGamepadMask(gamepad({ buttons: [0, 9, 14] }))).toBe(
      VOX_BTN.a | VOX_BTN.start | VOX_BTN.left,
    );
    expect(standardGamepadMask(gamepad({ axes: [0.8, -0.8] }))).toBe(
      VOX_BTN.right | VOX_BTN.up,
    );
  });

  test("stick hysteresis holds until the release threshold", () => {
    const held = standardGamepadMask(gamepad({ axes: [0.7, 0] }));
    expect(held & VOX_BTN.right).not.toBe(0);
    expect(standardGamepadMask(gamepad({ axes: [0.4, 0] }), held) & VOX_BTN.right).not.toBe(0);
    expect(standardGamepadMask(gamepad({ axes: [0.2, 0] }), held) & VOX_BTN.right).toBe(0);
  });
});

describe("Pocket Voxel web clock", () => {
  test("logic remains 60 Hz while presentation can be 30 Hz", () => {
    const clock = new FixedClock(60, 30);
    clock.reset(100);
    expect(clock.frame(117)).toEqual({ steps: 1, render: false });
    expect(clock.frame(134)).toEqual({ steps: 1, render: true });
  });

  test("a background-tab jump is clamped and catch-up is bounded", () => {
    const clock = new FixedClock(60, 60, 4);
    clock.reset(100);
    const frame = clock.frame(10_000);
    expect(frame.steps).toBe(4);
    expect(frame.render).toBe(true);
    expect(clock.frame(10_017).steps).toBeLessThanOrEqual(2);
  });
});

describe("Pocket Voxel web pipeline UX", () => {
  test("progress phases are monotonic and finish at one", () => {
    const points = [
      progressFraction("verify", 1, 1),
      progressFraction("extract", 16, 16),
      progressFraction("atlas", 1, 1),
      progressFraction("map", 8, 8),
      progressFraction("ground-bake", 8, 8),
      progressFraction("pack", 1, 1),
    ];
    expect(points).toEqual([...points].sort((a, b) => a - b));
    expect(points.at(-1)).toBe(1);
  });

  test("wrong-ROM errors are distinguished from cook failures", () => {
    expect(isWrongRomError(
      "ROM SHA-1 mismatch: got 0000000000000000000000000000000000000000, " +
      "need Red ea9bcae617fdf159b045185467ae58b2e4a48b9a",
    )).toBe(true);
    expect(isWrongRomError("ROM size mismatch: got 16 bytes, need 1048576")).toBe(true);
    expect(isWrongRomError("Web Crypto is unavailable; cannot verify the ROM SHA-1")).toBe(false);
    expect(isWrongRomError("manifest is not for Red; Red-only for now")).toBe(false);
    expect(isWrongRomError("out of memory while packing atlas")).toBe(false);
  });

  test("page exposes a minimal ROM gate and the 3D stage instead of a second controller UI", async () => {
    const html = await Bun.file("web/index.html").text();
    for (const id of ["rom-file", "choose-rom", "progress-track", "screen", "live-status"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("data-stage-viewport");
    expect(html).not.toContain("data-voxel-button");
    expect(html).not.toContain('id="controls"');
    expect(html).not.toContain('id="render-rate"');
    expect(html).not.toContain('id="mute"');
    expect(html).not.toContain("player-topbar");
    expect(html).not.toContain("screen-frame");
    expect(html).toContain('aria-live="polite"');
    expect(html.toLowerCase()).toContain("no rom bytes or baked game data leave this browser");
  });

  test("Game Boy profile resolves local GLB assets and all runtime controls", async () => {
    const directory = join("web", "assets", "game-boy");
    const profile = (await Bun.file(join(directory, "profile.json")).json()) as {
      schema_version?: number;
      attribution?: string;
      lods?: Record<string, string>;
      screen?: {
        expected_primitives?: number;
        material_role?: string;
        material_name_prefix?: string;
      };
      parts?: { button?: string }[];
    };
    expect(profile.schema_version).toBe(1);
    expect(profile.screen?.expected_primitives).toBe(1);
    expect(profile.screen?.material_role).toBe("dynamic_screen");
    expect(profile.screen?.material_name_prefix).toBe("P3D_dynamic_screen__");
    expect(profile.attribution).toBeTruthy();
    expect(profile.attribution).not.toMatch(/[\\/]|\.\./);
    expect(await Bun.file(join(directory, profile.attribution!)).exists()).toBe(true);

    const models = new Set(Object.values(profile.lods ?? {}));
    expect(models.size).toBeGreaterThan(0);
    for (const model of models) {
      expect(model).toMatch(/\.glb$/);
      expect(model).not.toMatch(/[\\/]|\.\./);
      const modelFile = Bun.file(join(directory, model));
      expect(await modelFile.exists()).toBe(true);

      const gltf = decodeGlbJson(new Uint8Array(await modelFile.arrayBuffer()));
      const dynamicMaterials = (gltf.materials ?? [])
        .map((material, index) => ({ material, index }))
        .filter(
          ({ material }) =>
            material.extras?.pocket3d_role === profile.screen?.material_role ||
            material.name?.startsWith(profile.screen?.material_name_prefix ?? "") === true,
        );
      expect(dynamicMaterials).toHaveLength(1);
      expect(dynamicMaterials[0].material.pbrMetallicRoughness?.baseColorTexture).toBeUndefined();
      const primitives = (gltf.meshes ?? []).flatMap((mesh) => mesh.primitives ?? []);
      const dynamicPrimitives = primitives.filter(
        (primitive) => primitive.material === dynamicMaterials[0].index,
      );
      expect(dynamicPrimitives).toHaveLength(profile.screen?.expected_primitives ?? 0);
      const screenPrimitive = dynamicPrimitives[0];
      expect(screenPrimitive.attributes?.TEXCOORD_0).toBeNumber();
      const position = gltf.accessors?.[screenPrimitive.attributes?.POSITION ?? -1];
      const spans = (position?.max ?? [])
        .map((maximum, axis) => maximum - (position?.min?.[axis] ?? maximum))
        .filter((span) => span > 1e-5)
        .sort((a, b) => b - a);
      expect(spans).toHaveLength(2);
      expect(spans[0] / spans[1]).toBeCloseTo(30 / 17, 4);
    }

    const buttons = new Set(
      (profile.parts ?? [])
        .map((part) => part.button)
        .filter((button): button is string => typeof button === "string"),
    );
    expect((profile.parts ?? []).filter((part) => part.button)).toHaveLength(8);
    expect(buttons).toEqual(
      new Set(["up", "down", "left", "right", "circle", "cross", "select", "start"]),
    );
  });

  test("web runtime dependencies ship reachable license notices", async () => {
    const notices = await Bun.file("web/reference/third-party/THIRD_PARTY_NOTICES.md").text();
    for (const [component, license] of [
      ["three.js", "three-LICENSE.txt"],
      ["wasm-bindgen", "wasm-bindgen-LICENSE-MIT.txt"],
      ["cfg-if", "cfg-if-LICENSE-MIT.txt"],
      ["once_cell", "once_cell-LICENSE-MIT.txt"],
      ["self_cell", "self_cell-LICENSE-APACHE.txt"],
      ["unicode-ident", "unicode-ident-LICENSE-MIT.txt"],
      ["unicode-ident", "unicode-ident-LICENSE-UNICODE.txt"],
    ] as const) {
      expect(notices).toContain(component);
      expect(notices).toContain(license);
      expect(await Bun.file(join("web", "reference", "third-party", license)).exists()).toBe(true);
    }
    const html = await Bun.file("web/index.html").text();
    expect(html).toContain("./third-party/runtime/THIRD_PARTY_NOTICES.md");
  });

  test("the two browser entries bundle without Node or Bun runtime APIs", async () => {
    const built = await Bun.build({
      entrypoints: ["web/main.ts", "web/cook.worker.ts"],
      target: "browser",
      format: "esm",
    });
    expect(built.success).toBe(true);
    const text = (await Promise.all(built.outputs.map((output) => output.text()))).join("\n");
    expect(text).not.toMatch(/from ["']node:/);
    expect(text).not.toContain("Bun.file(");
    expect(text).not.toContain("Bun.spawn");
  });
});
