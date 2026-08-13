import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { FixedClock } from "../web/clock.ts";
import { InputMux, standardGamepadMask } from "../web/input.ts";
import { isWrongRomError, progressFraction } from "../web/protocol.ts";
import { redirectToHttps } from "../web/https.ts";

type GlbJson = {
  scenes?: { extras?: Record<string, unknown> }[];
  nodes?: { name?: string; camera?: number }[];
  materials?: {
    name?: string;
    extras?: Record<string, unknown>;
    pbrMetallicRoughness?: { baseColorTexture?: unknown };
  }[];
  meshes?: { primitives?: {
    indices?: number;
    material?: number;
    attributes?: { POSITION?: number; TEXCOORD_0?: number };
  }[] }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType?: number;
    count?: number;
    type?: string;
    min?: number[];
    max?: number[];
  }[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteStride?: number }[];
  buffers?: { uri?: string }[];
  images?: unknown[];
  textures?: unknown[];
  animations?: unknown[];
  cameras?: unknown[];
  extensionsUsed?: string[];
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

function decodeGlbVec2(bytes: Uint8Array, gltf: GlbJson, accessorIndex: number): [number, number][] {
  const accessor = gltf.accessors?.[accessorIndex];
  expect(accessor?.componentType).toBe(5126);
  expect(accessor?.type).toBe("VEC2");
  const bufferView = gltf.bufferViews?.[accessor?.bufferView ?? -1];
  expect(bufferView?.buffer ?? 0).toBe(0);
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const binaryHeader = 20 + header.getUint32(12, true);
  expect(header.getUint32(binaryHeader + 4, true)).toBe(0x004e4942);
  const binaryStart = binaryHeader + 8;
  const start = binaryStart + (bufferView?.byteOffset ?? 0) + (accessor?.byteOffset ?? 0);
  const stride = bufferView?.byteStride ?? 8;
  const values = new DataView(bytes.buffer, bytes.byteOffset + start, bytes.byteLength - start);
  return Array.from({ length: accessor?.count ?? 0 }, (_, index) => [
    values.getFloat32(index * stride, true),
    values.getFloat32(index * stride + 4, true),
  ]);
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
  test("edge entrypoint redirects cleartext requests without changing the URL", () => {
    const cleartext = new Request("http://pocketvoxel.games/assets/og-image.png?source=test");
    const redirect = redirectToHttps(cleartext);
    expect(redirect?.status).toBe(308);
    expect(redirect?.headers.get("location")).toBe(
      "https://pocketvoxel.games/assets/og-image.png?source=test",
    );
    expect(redirectToHttps(new Request("https://pocketvoxel.games/"))).toBeNull();
  });

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
    for (const id of [
      "rom-file",
      "choose-rom",
      "progress-track",
      "screen",
      "live-status",
      "help-open",
      "help-dialog",
      "help-close",
      "credits-open",
      "credits-dialog",
      "credits-close",
      "rotation-toggle",
      "mobile-tools",
      "mobile-tools-toggle",
      "mobile-tools-panel",
      "mode-options",
      "mode-web",
      "mode-homebrew",
      "native-target-options",
      "target-psp",
      "target-vita",
      "target-result",
      "target-action",
    ]) {
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
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-labelledby="help-title"');
    expect(html).toContain('aria-labelledby="credits-title"');
    expect(html).toContain("<kbd>");
    expect(html).toContain('class="brand-frame"');
    expect(html).toContain('class="brand-voxel brand-voxel--top"');
    expect(html).not.toContain('class="brand-pocket"');
    expect(html).not.toContain("brand-wordmark");
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="./favicon.svg"');
    expect(html).not.toContain('href="data:,"');
    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html).toContain('name="mode"');
    expect(html).toContain('name="native-target"');
    expect(html).toContain("<span>PSP</span>");
    expect(html).toContain("<span>PSV</span>");
    expect(html).not.toContain("PSP · EBOOT");
    expect(html).not.toContain("PS Vita · VPK");
    expect(html.match(/href="https:\/\/github\.com\/pocket-stack\/pocket-voxel"/g)).toHaveLength(3);
    expect(html).toContain('class="brand"');
    expect(html).toContain('href="https://github.com/pocket-stack/pocket-voxel"');
    expect(html).toContain('aria-label="Pocket Voxel on GitHub"');
    expect(html).toContain("Star on GitHub");
    expect(html).toContain('aria-controls="mobile-tools-panel"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Open page menu"');
    expect(html).toContain('href="https://pocketjs.dev/"');
    expect(html).toContain('aria-label="Powered by PocketJS"');
    expect(html).toContain("<span>Powered by</span>");
    expect(html).toContain("<strong>PocketJS</strong>");
    expect(html).toContain('id="powered-pj-edge"');
    expect(html).toContain('<circle cx="10" cy="16" r="3.1"');
    expect(html).not.toContain('id="target-web"');
    expect(html).not.toContain('id="target-options"');
    expect(html).toContain("<title>Pocket Voxel</title>");
    expect(html).toContain('id="hero-title" class="sr-only">Pocket Voxel</h1>');
    expect(html).toContain("Insert a Pokémon Red cartridge");
    expect(html).not.toContain("ROM processing stays local");
    expect(html).not.toContain("A CARTRIDGE-SIZED 3D WORLD");
    expect(html).not.toContain("Put the whole adventure");
    expect(html).not.toContain("Pocket Voxel builds the diorama");
    expect(html).not.toContain("READY FOR CARTRIDGE");
    expect(html).not.toContain("Click the LCD or drop a ROM anywhere");
    expect(html).not.toContain("Arrows / WASD · Z / J = A");
    expect(html.toLowerCase()).not.toContain("no rom bytes or baked game data leave this browser");
    expect(html).not.toContain("Bring a ROM you lawfully own");
    expect(html).not.toContain("Pocket Voxel includes no game content");
    expect(html).not.toContain('class="play-notes"');
    expect(html).not.toContain("<footer");

    const main = await Bun.file("web/main.ts").text();
    expect(main).toContain('context.fillText("POCKET VOXEL", 8, 22)');
    expect(main).not.toContain("CARTRIDGE BAY");
    expect(main).not.toContain("POKÉMON RED · CHOOSE A CANONICAL 1 MiB ROM OR DROP IT ANYWHERE.");
    expect(main).not.toContain("CLICK LCD OR DROP A 1 MiB ROM");
    expect(main).not.toContain("Web Player is running in the Game Boy above.");
    expect(main).not.toContain("Focus player");
    expect(main).not.toContain("LIVE · RUST + WASM");
    expect(main).not.toContain("READY FOR CARTRIDGE");
    expect(main).not.toContain("Click the LCD or drop a ROM anywhere");
    expect(main).not.toContain("Arrows / WASD · Z / J = A");
    expect(main).not.toContain("resumeAfterHelp");
    expect(main).toContain("creditsDialog.open");
    expect(main).toContain('selectedMode() !== "web"');
    expect(main).toContain('input[name="mode"]');
    expect(main).toContain('input[name="native-target"]');
    expect(main).toContain("nativeTargetOptions.hidden");
    expect(main).toContain('const ROTATION_PREFERENCE_KEY = "pocket-voxel:rotation-enabled"');
    expect(main).toContain("window.localStorage.getItem(ROTATION_PREFERENCE_KEY)");
    expect(main).toContain("window.localStorage.setItem(ROTATION_PREFERENCE_KEY, String(enabled))");
    expect(main).toContain('window.matchMedia("(max-width: 780px)")');
    expect(main).toContain('mobileToolsToggle.setAttribute("aria-expanded", String(open))');
    expect(main).toContain('event.key === "Escape" && mobileTools.classList.contains("is-open")');
    expect(main).toContain("mobileToolsMedia.matches ? mobileToolsToggle : opener");
    expect(main.indexOf("rotationToggle.checked = readRotationPreference()")).toBeLessThan(
      main.indexOf("mountGameBoyStage({"),
    );
    expect(main).toContain('new URL("./export.worker.js"');
    expect(main).toContain("cooked.pak.slice(0)");

    const syncTargetResult = main.slice(
      main.indexOf("function syncTargetResult("),
      main.indexOf("function resetRuntime("),
    );
    expect(syncTargetResult).toContain('target === "web" && runtime');
    expect(syncTargetResult).toContain('targetResultCopy.textContent = ""');
    expect(syncTargetResult).toContain('targetAction.textContent = ""');

    const updateProgress = main.slice(
      main.indexOf("function updateProgress("),
      main.indexOf("function showError("),
    );
    expect(updateProgress).toContain("if (!stageFailure)");
    expect(updateProgress).toContain('stageRoot.dataset.state = "cooking"');

    const showError = main.slice(
      main.indexOf("function showError("),
      main.indexOf("function openRomPicker("),
    );
    expect(showError).toContain('progressTrack.setAttribute("aria-valuenow", "0")');
    expect(showError).toContain('progressTrack.setAttribute("aria-valuetext"');

    const stageFailure = main.slice(
      main.indexOf("function showStageFailure("),
      main.indexOf("function showWebError("),
    );
    expect(stageFailure).toContain("stageCanvas.tabIndex = -1");
    expect(stageFailure).toContain('stageCanvas.setAttribute("aria-disabled", "true")');
    expect(stageFailure).toContain('const fallbackTarget: NativeTarget = "psp"');
    expect(stageFailure).toContain("webMode.disabled = true");
    expect(stageFailure).toContain("homebrewMode.checked = true");
    expect(stageFailure).toContain("nativeTargetInput(fallbackTarget).checked = true");

    const buildNative = main.slice(
      main.indexOf("function buildNative("),
      main.indexOf("async function prepareTarget("),
    );
    expect(buildNative.match(/announce\(`\$\{targetLabel\(target\)\} build failed\./g)).toHaveLength(3);

    const styles = await Bun.file("web/styles.css").text();
    expect(styles).toContain(".cartridge-action");
    expect(styles).toContain("width: min(100%, 46rem)");
    expect(styles).toContain("overflow: hidden");
    expect(styles).toContain("grid-template-rows: auto minmax(0, 1fr)");
    expect(styles).not.toContain(".local-note");
    expect(styles).not.toContain(".stage-meta");
    expect(styles).not.toContain(".landing-footer");
    expect(styles).toContain(".mobile-tools.is-open .nav-tools { display: flex; }");
    expect(styles).toContain(".powered-by");
    expect(styles).toContain(".help-dialog__close span::before");
    expect(styles).toContain("rotate(-45deg)");
    const navStyles = styles.slice(styles.indexOf(".nav-button,"), styles.indexOf("main {"));
    expect(navStyles).not.toContain("text-transform: uppercase");

    const stageSource = await Bun.file("web/stage.ts").text();
    expect(stageSource).toContain("setRotationEnabled(enabled: boolean)");
    expect(stageSource).toContain("rotationEnabled && pressed.size === 0");
    expect(stageSource).toContain('root.dataset.rotationEnabled = String(rotationEnabled)');
    expect(stageSource).toContain("releaseInput()");
    expect(stageSource).toContain("options.initialRotationEnabled ?? true");
    expect(stageSource).not.toContain("controls.enabled = pressed.size === 0");

    const favicon = await Bun.file("web/favicon.svg").text();
    expect(favicon).toContain('viewBox="0 0 32 32"');
    expect(favicon).toContain('rx="7" fill="#0a0a0c"');
    expect(favicon).toContain('fill="#9de5c7"');
    expect(favicon).toContain('fill="#5e7183"');
    expect(favicon).toContain('fill="#d8e1ec"');

    const readme = await Bun.file("README.md").text();
    expect(readme).toStartWith(
      '<h1><img src="./web/favicon.svg" width="40" height="40" alt="" align="absmiddle" /> Pocket Voxel</h1>',
    );
    expect(readme).toContain("the Web Player, a real PSP and a real PS Vita");

    const buildSource = await Bun.file("web/scripts/build.ts").text();
    expect(buildSource).toContain('"audio-worklet.js"');
    expect(buildSource).toContain('"favicon.svg"');

    const wasmBuildSource = await Bun.file("web/scripts/build-wasm.ts").text();
    expect(wasmBuildSource).toContain("--remap-path-prefix=${sourceHome}=/source/home");
    expect(wasmBuildSource).toContain("--remap-path-prefix=${root}=/source/pocket-voxel");

    const wrangler = await Bun.file("wrangler.jsonc").json();
    expect(wrangler.name).toBe("pocket-voxel-web");
    expect(wrangler.main).toBe("./worker/entry.ts");
    expect(wrangler.compatibility_date).toBe("2026-08-12");
    expect(wrangler.assets).toEqual({
      directory: "./dist/web",
      binding: "ASSETS",
      not_found_handling: "none",
      run_worker_first: true,
    });
    expect(wrangler.routes).toEqual([
      { pattern: "pocketvoxel.games", custom_domain: true },
    ]);

    const packageJson = await Bun.file("package.json").json();
    expect(packageJson.scripts?.["web:deploy"]).toBe("bun run web:build && wrangler deploy");

    const redirectSource = await Bun.file("web/https.ts").text();
    expect(redirectSource).toContain('if (url.protocol !== "http:") return null');
    expect(redirectSource).toContain("return Response.redirect(url.toString(), 308)");

    const edgeSource = await Bun.file("worker/entry.ts").text();
    expect(edgeSource).toContain("return env.ASSETS.fetch(request)");
    expect(edgeSource).not.toContain(".text()");
    expect(edgeSource).not.toContain(".arrayBuffer()");

    const workerTypes = await Bun.file("worker/worker-configuration.d.ts").text();
    expect(workerTypes).toContain("ASSETS: Fetcher");

    const edgeHeaders = await Bun.file("web/_headers").text();
    expect(edgeHeaders).toContain("Strict-Transport-Security: max-age=31536000");
    expect(edgeHeaders).toContain("X-Content-Type-Options: nosniff");
  });

  test("publishes canonical search and social metadata", async () => {
    const html = await Bun.file("web/index.html").text();
    const canonicalUrl = "https://pocketvoxel.games/";
    const socialImage = `${canonicalUrl}assets/og-image.png`;

    expect(html).toContain(`<link rel="canonical" href="${canonicalUrl}"`);
    expect(html).toContain('name="robots" content="index, follow, max-image-preview:large"');
    expect(html).toContain('property="og:type" content="website"');
    expect(html).toContain('property="og:site_name" content="Pocket Voxel"');
    expect(html).toContain(`property="og:url" content="${canonicalUrl}"`);
    expect(html).toContain(`property="og:image" content="${socialImage}"`);
    expect(html).toContain('property="og:image:width" content="1200"');
    expect(html).toContain('property="og:image:height" content="630"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain(`name="twitter:image" content="${socialImage}"`);

    const jsonLd = html.match(
      /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/,
    )?.[1];
    expect(jsonLd).toBeDefined();
    const application = JSON.parse(jsonLd!) as Record<string, unknown>;
    expect(application).toMatchObject({
      "@context": "https://schema.org",
      "@type": "WebApplication",
      "@id": `${canonicalUrl}#application`,
      name: "Pocket Voxel",
      url: canonicalUrl,
      applicationCategory: "GameApplication",
      operatingSystem: "Web browser",
      image: socialImage,
      sameAs: "https://github.com/pocket-stack/pocket-voxel",
      isAccessibleForFree: true,
    });

    expect(await Bun.file("web/robots.txt").text()).toBe(
      `User-agent: *\nAllow: /\n\nSitemap: ${canonicalUrl}sitemap.xml\n`,
    );
    expect(await Bun.file("web/sitemap.xml").text()).toContain(
      `<loc>${canonicalUrl}</loc>`,
    );

    const buildSource = await Bun.file("web/scripts/build.ts").text();
    expect(buildSource).toContain('"robots.txt"');
    expect(buildSource).toContain('"sitemap.xml"');
    expect(buildSource).toContain('join(web, "assets", "og-image.png")');

    const ogImage = Bun.file("web/assets/og-image.png");
    expect(await ogImage.exists()).toBe(true);
    const ogBytes = new Uint8Array(await ogImage.arrayBuffer());
    expect(new TextDecoder("latin1").decode(ogBytes.subarray(1, 4))).toBe("PNG");
    const ogHeader = new DataView(ogBytes.buffer, ogBytes.byteOffset, ogBytes.byteLength);
    expect(ogHeader.getUint32(16)).toBe(1200);
    expect(ogHeader.getUint32(20)).toBe(630);
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

      const modelBytes = new Uint8Array(await modelFile.arrayBuffer());
      expect(modelBytes.byteLength).toBeGreaterThan(500_000);
      expect(modelBytes.byteLength).toBeLessThanOrEqual(5 * 1024 * 1024);
      expect(new TextDecoder().decode(modelBytes).toLowerCase()).not.toContain("nintendo");

      const gltf = decodeGlbJson(modelBytes);
      expect(gltf.images ?? []).toHaveLength(0);
      expect(gltf.textures ?? []).toHaveLength(0);
      expect(gltf.animations ?? []).toHaveLength(0);
      expect(gltf.cameras ?? []).toHaveLength(0);
      expect(gltf.extensionsUsed ?? []).toHaveLength(0);
      expect((gltf.buffers ?? []).every((buffer) => buffer.uri === undefined)).toBe(true);
      expect((gltf.scenes ?? []).every((scene) => scene.extras === undefined)).toBe(true);
      expect((gltf.nodes ?? []).map((node) => node.name)).not.toContain("Backdrop");

      const triangles = (gltf.meshes ?? [])
        .flatMap((mesh) => mesh.primitives ?? [])
        .reduce((total, primitive) => {
          const accessor = gltf.accessors?.[primitive.indices ?? -1];
          return total + (accessor?.count ?? 0) / 3;
        }, 0);
      expect(triangles).toBeGreaterThanOrEqual(17_500);
      expect(triangles).toBeLessThanOrEqual(19_000);

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
      expect(spans[0] / spans[1]).toBeCloseTo(160 / 144, 4);
      const uv = decodeGlbVec2(modelBytes, gltf, screenPrimitive.attributes?.TEXCOORD_0 ?? -1);
      const u = uv.map(([value]) => value);
      const v = uv.map(([, value]) => value);
      expect(Math.min(...u)).toBeCloseTo(5 / 27, 5);
      expect(Math.max(...u)).toBeCloseTo(22 / 27, 5);
      expect(Math.min(...v)).toBeCloseTo(0, 5);
      expect(Math.max(...v)).toBeCloseTo(1, 5);
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

  test("redistributable model source is de-branded and correctly attributed", async () => {
    const directory = join("web", "assets", "game-boy");
    const source = Bun.file(join(directory, "source", "lets-do-3d-gameboy-dmg-01.glb"));
    expect(await source.exists()).toBe(true);
    const sourceBytes = new Uint8Array(await source.arrayBuffer());
    expect(new TextDecoder().decode(sourceBytes).toLowerCase()).not.toContain("nintendo");
    const gltf = decodeGlbJson(sourceBytes);
    expect(gltf.images ?? []).toHaveLength(0);
    expect(gltf.textures ?? []).toHaveLength(0);
    expect(gltf.cameras ?? []).toHaveLength(0);

    const attribution = await Bun.file(join(directory, "ATTRIBUTION.md")).text();
    expect(attribution).toContain("Let's Do 3D");
    expect(attribution).toContain("CC BY 4.0");
    expect(attribution).toContain("29849a15fe0a40a6a18e01c9d544a0ed");
  });

  test("web runtime dependencies ship reachable license notices", async () => {
    const notices = await Bun.file("web/reference/third-party/THIRD_PARTY_NOTICES.md").text();
    for (const [component, license] of [
      ["three.js", "three-LICENSE.txt"],
      ["wasm-bindgen", "wasm-bindgen-LICENSE-MIT.txt"],
      ["cfg-if", "cfg-if-LICENSE-MIT.txt"],
      ["once_cell", "once_cell-LICENSE-MIT.txt"],
      ["self_cell", "self_cell-LICENSE-APACHE.txt"],
      ["miniz_oxide", "miniz_oxide-LICENSE-MIT.md"],
      ["adler2", "adler2-LICENSE-MIT.txt"],
      ["unicode-ident", "unicode-ident-LICENSE-MIT.txt"],
      ["unicode-ident", "unicode-ident-LICENSE-UNICODE.txt"],
      ["PocketJS", "pocketjs-LICENSE.txt"],
      ["QuickJS", "quickjs-LICENSE.txt"],
      ["rust-psp", "rust-psp-LICENSE.txt"],
      ["vita2d", "vita2d-LICENSE.txt"],
      ["vitasdk-sys", "vitasdk-sys-LICENSE-MIT.txt"],
    ] as const) {
      expect(notices).toContain(component);
      expect(notices).toContain(license);
      expect(await Bun.file(join("web", "reference", "third-party", license)).exists()).toBe(true);
    }
    const html = await Bun.file("web/index.html").text();
    expect(html).toContain("./third-party/runtime/THIRD_PARTY_NOTICES.md");
  });

  test("console host templates are ROM-independent and hash-pinned", async () => {
    const manifest = await Bun.file("web/platform/manifest.json").json() as {
      schemaVersion: number;
      vxpkVersion: number;
      guestSha256: string;
      psp: { files: { id: string; path: string; bytes: number; sha256: string }[] };
      vita: { files: { id: string; path: string; bytes: number; sha256: string }[] };
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.vxpkVersion).toBe(9);
    const guest = await Bun.build({
      entrypoints: ["voxelmon/game/psp-main.ts"],
      target: "browser",
      format: "iife",
      minify: { syntax: true, whitespace: false, identifiers: false },
    });
    expect(guest.success).toBe(true);
    const guestBytes = new Uint8Array(await guest.outputs[0]!.arrayBuffer());
    expect(new Bun.CryptoHasher("sha256").update(guestBytes).digest("hex")).toBe(
      manifest.guestSha256,
    );
    expect(manifest.psp.files.map(({ id }) => id)).toEqual(["prx", "icon0", "pic1", "notices"]);
    expect(manifest.vita.files.map(({ id }) => id)).toEqual([
      "eboot",
      "sfo",
      "icon0",
      "background",
      "startup",
      "template",
      "notices",
    ]);
    for (const entry of [...manifest.psp.files, ...manifest.vita.files]) {
      expect(entry.path).not.toMatch(/(^|\/)\.\.?(\/|$)|\\/);
      expect(entry.path).not.toMatch(/\.(?:gb|gbc|vxpak)$/i);
      const file = Bun.file(join("web", "platform", entry.path));
      expect(await file.exists()).toBe(true);
      const bytes = new Uint8Array(await file.arrayBuffer());
      expect(bytes.byteLength).toBe(entry.bytes);
      const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      expect(actual).toBe(entry.sha256);
    }
    const pspNotices = manifest.psp.files.find(({ id }) => id === "notices");
    const vitaNotices = manifest.vita.files.find(({ id }) => id === "notices");
    expect(pspNotices).toEqual(vitaNotices);
    const notices = await Bun.file(join("web", "platform", pspNotices!.path)).text();
    for (const component of [
      "QuickJS",
      "rust-psp",
      "PSPSDK",
      "libvita2d",
      "vitasdk-sys",
      "slotmap",
      "Newlib",
      "Unicode License v3",
    ]) {
      expect(notices).toContain(component);
    }
    const embeddedGuest = Buffer.from(guestBytes);
    for (const [target, id] of [["psp", "prx"], ["vita", "eboot"]] as const) {
      const entry = manifest[target].files.find((file) => file.id === id);
      expect(entry).toBeTruthy();
      const host = Buffer.from(await Bun.file(join("web", "platform", entry!.path)).arrayBuffer());
      expect(host.includes(embeddedGuest)).toBe(true);
      expect(host.includes(Buffer.from("/Users/evan"))).toBe(false);
      expect(host.includes(Buffer.from("thread-cone"))).toBe(false);
      expect(host.includes(Buffer.from("/source/pocket-voxel"))).toBe(true);
    }
    const artwork = [
      await Bun.file("web/platform/source/icon.svg").text(),
      await Bun.file("web/platform/source/banner.svg").text(),
      await Bun.file("web/platform/source/startup.svg").text(),
    ].join("\n").toLowerCase();
    expect(artwork).not.toContain("pokemon");
    expect(artwork).not.toContain("nintendo");
    expect(artwork).not.toContain("game boy");
  });

  test("all three browser entries bundle without Node or Bun runtime APIs", async () => {
    const built = await Bun.build({
      entrypoints: ["web/main.ts", "web/cook.worker.ts", "web/export.worker.ts"],
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
