import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import type { InputMux, VoxelButton } from "./input.ts";

const PROFILE_URL = new URL("./assets/game-boy/profile.json", import.meta.url);
const ORBIT_YAW_LIMIT = 0.68;
const ORBIT_PITCH_LIMIT = 0.34;
const MIN_BUTTON_HOLD_MS = 42;

type Vector3Tuple = [number, number, number];

interface StagePart {
  name: string;
  button?: string;
  center_mm: Vector3Tuple;
  half_extents_mm: Vector3Tuple;
}

interface StageProfile {
  target_width_mm: number;
  rotation_degrees?: Vector3Tuple;
  lods: { orbit: string };
  view?: {
    desk_position_mm?: Vector3Tuple;
    desk_target_mm?: Vector3Tuple;
    fov_y_degrees?: number;
  };
  screen: {
    material_role: string;
    material_name_prefix: string;
    expected_primitives: number;
  };
  parts?: StagePart[];
}

interface PressedPart {
  button: VoxelButton;
  source: string;
  startedAt: number;
  releaseTimer?: number;
}

export interface GameBoyStageOptions {
  root: HTMLElement;
  viewport: HTMLElement;
  canvas: HTMLCanvasElement;
  framebuffer: HTMLCanvasElement;
  input: InputMux;
  onScreenActivate: () => void;
  onError: (error: Error) => void;
}

export interface GameBoyStage {
  readonly canvas: HTMLCanvasElement;
  blit(): void;
  setScreenActionEnabled(enabled: boolean): void;
  setRuntimeReady(ready: boolean): void;
  destroy(): void;
}

const BUTTON_MAP: Readonly<Record<string, VoxelButton>> = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  circle: "a",
  cross: "b",
  start: "start",
  select: "select",
};

function failResponse(response: Response): Response {
  if (!response.ok) throw new Error(`${response.url}: HTTP ${response.status}`);
  return response;
}

function canonicalizeModel(rawScene: THREE.Object3D, profile: StageProfile): THREE.Group {
  const degrees = profile.rotation_degrees ?? [0, 0, 0];
  rawScene.rotation.set(...degrees.map(THREE.MathUtils.degToRad) as Vector3Tuple);
  rawScene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(rawScene);
  const width = bounds.getSize(new THREE.Vector3()).x;
  const center = bounds.getCenter(new THREE.Vector3());
  if (!(width > 0)) throw new Error("The Game Boy model has a degenerate width.");
  rawScene.position.copy(center).multiplyScalar(-1);
  const canonical = new THREE.Group();
  canonical.name = "pocket-voxel-game-boy";
  canonical.scale.setScalar(profile.target_width_mm / width);
  canonical.add(rawScene);
  canonical.updateMatrixWorld(true);
  return canonical;
}

function bindScreen(
  model: THREE.Object3D,
  profile: StageProfile,
  texture: THREE.CanvasTexture,
): void {
  let matches = 0;
  const configure = (source: THREE.Material): THREE.Material => {
    const role = source.userData.pocket3d_role;
    if (role !== profile.screen.material_role && !source.name.startsWith(profile.screen.material_name_prefix)) {
      return source;
    }
    matches += 1;
    const material = new THREE.MeshBasicMaterial({
      name: source.name,
      map: texture,
      color: 0xffffff,
      side: THREE.DoubleSide,
      toneMapped: false,
      depthWrite: true,
    });
    material.userData = { ...source.userData };
    source.dispose();
    return material;
  };
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.material = Array.isArray(object.material)
      ? object.material.map(configure)
      : configure(object.material);
  });
  if (matches !== profile.screen.expected_primitives) {
    throw new Error(`The Game Boy screen matched ${matches} primitives; expected ${profile.screen.expected_primitives}.`);
  }
}

function buildPickProxies(profile: StageProfile): THREE.Group {
  const group = new THREE.Group();
  group.name = "pocket-voxel-game-boy-controls";
  for (const part of profile.parts ?? []) {
    if (!part.button && part.name !== "screen") continue;
    const [hx, hy, hz] = part.half_extents_mm;
    const proxy = new THREE.Mesh(
      new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2),
      new THREE.MeshBasicMaterial(),
    );
    proxy.layers.set(2);
    proxy.position.fromArray(part.center_mm);
    proxy.userData.stagePart = part;
    group.add(proxy);
  }
  return group;
}

export async function mountGameBoyStage(options: GameBoyStageOptions): Promise<GameBoyStage> {
  const { root, viewport, canvas, framebuffer, input } = options;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
      premultipliedAlpha: true,
    });
  } catch (error) {
    throw new Error(`Interactive 3D is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 1, 1000);
  camera.position.set(0, 10, 285);

  scene.add(new THREE.HemisphereLight(0xd9f5ff, 0x07121d, 2.6));
  const key = new THREE.DirectionalLight(0xffffff, 3.4);
  key.position.set(-100, 150, 190);
  scene.add(key);
  const mintRim = new THREE.DirectionalLight(0x72f2c6, 1.4);
  mintRim.position.set(120, 60, -80);
  scene.add(mintRim);
  const roseRim = new THREE.DirectionalLight(0xff5577, 0.75);
  roseRim.position.set(-100, -20, 70);
  scene.add(roseRim);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(62, 64),
    new THREE.MeshBasicMaterial({ color: 0x06101a, transparent: true, opacity: 0.42, depthWrite: false }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -67, -2);
  floor.scale.set(1, 0.32, 1);
  scene.add(floor);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = false;
  controls.rotateSpeed = 0.52;
  controls.minAzimuthAngle = -ORBIT_YAW_LIMIT;
  controls.maxAzimuthAngle = ORBIT_YAW_LIMIT;
  controls.minPolarAngle = Math.PI / 2 - ORBIT_PITCH_LIMIT;
  controls.maxPolarAngle = Math.PI / 2 + ORBIT_PITCH_LIMIT;
  controls.update();

  const texture = new THREE.CanvasTexture(framebuffer);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.NearestFilter;

  let proxyGroup: THREE.Group | null = null;
  let loadedModel: THREE.Object3D | null = null;
  let renderRaf = 0;
  let renderCount = 0;
  let screenFrames = 0;
  let inViewport = true;
  let destroyed = false;
  let screenActionEnabled = true;
  let stageWidthMm = 90;
  let authoredCameraRadius = camera.position.distanceTo(controls.target);
  const pressed = new Map<number, PressedPart>();

  const renderNow = () => {
    renderRaf = 0;
    if (destroyed || !inViewport || document.hidden) return;
    renderer.render(scene, camera);
    renderCount += 1;
    root.dataset.stageFrames = String(renderCount);
  };
  const invalidate = () => {
    if (destroyed || !inViewport || document.hidden || renderRaf) return;
    renderRaf = requestAnimationFrame(renderNow);
  };
  const resize = () => {
    if (destroyed) return;
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const horizontalHalfAngle = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
    const fittedRadius = (stageWidthMm * 0.6) / Math.max(horizontalHalfAngle, 0.01);
    const offset = camera.position.clone().sub(controls.target);
    offset.setLength(Math.max(authoredCameraRadius, fittedRadius));
    camera.position.copy(controls.target).add(offset);
    camera.updateProjectionMatrix();
    controls.update();
    invalidate();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(viewport);

  const raycaster = new THREE.Raycaster();
  raycaster.layers.set(2);
  const pointer = new THREE.Vector2();
  const pick = (event: PointerEvent): StagePart | null => {
    if (!proxyGroup) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(proxyGroup.children, false)[0];
    return (hit?.object.userData.stagePart as StagePart | undefined) ?? null;
  };

  const updatePressedReceipt = () => {
    root.dataset.pressedPart = [...pressed.values()].map(({ button }) => button).join(",");
  };
  const clearPress = (pointerId: number, expected?: PressedPart) => {
    const active = pressed.get(pointerId);
    if (!active || (expected && active !== expected)) return;
    if (active.releaseTimer !== undefined) window.clearTimeout(active.releaseTimer);
    pressed.delete(pointerId);
    input.clearSource(active.source);
    controls.enabled = pressed.size === 0;
    updatePressedReceipt();
  };
  const release = (event: PointerEvent, immediate = false) => {
    const active = pressed.get(event.pointerId);
    if (!active) return;
    if (immediate && active.releaseTimer !== undefined) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const wait = immediate ? 0 : Math.max(0, MIN_BUTTON_HOLD_MS - (performance.now() - active.startedAt));
    if (wait === 0) clearPress(event.pointerId, active);
    else if (active.releaseTimer === undefined) {
      active.releaseTimer = window.setTimeout(() => clearPress(event.pointerId, active), wait);
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const part = pick(event);
    if (part?.name === "screen" && screenActionEnabled) {
      event.preventDefault();
      event.stopImmediatePropagation();
      options.onScreenActivate();
      return;
    }
    const button = part?.button ? BUTTON_MAP[part.button] : undefined;
    if (!button || !(button in VOX_BTN)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const source = `stage:${event.pointerId}`;
    clearPress(event.pointerId);
    pressed.set(event.pointerId, { button, source, startedAt: performance.now() });
    input.set(source, button, true);
    controls.enabled = false;
    canvas.setPointerCapture(event.pointerId);
    updatePressedReceipt();
  };
  const onPointerUp = (event: PointerEvent) => release(event);
  const onPointerCancel = (event: PointerEvent) => release(event, true);
  const onLostPointerCapture = (event: PointerEvent) => release(event, true);
  const onPointerMove = (event: PointerEvent) => {
    const part = pick(event);
    canvas.style.cursor = part?.button || (part?.name === "screen" && screenActionEnabled) ? "pointer" : "grab";
  };
  canvas.addEventListener("pointerdown", onPointerDown, true);
  canvas.addEventListener("pointerup", onPointerUp, true);
  canvas.addEventListener("pointercancel", onPointerCancel, true);
  canvas.addEventListener("lostpointercapture", onLostPointerCapture, true);
  canvas.addEventListener("pointermove", onPointerMove);

  const clearAllPresses = () => {
    for (const pointerId of [...pressed.keys()]) clearPress(pointerId);
  };
  window.addEventListener("blur", clearAllPresses);
  controls.addEventListener("change", invalidate);

  const visibilityObserver = new IntersectionObserver(([entry]) => {
    inViewport = entry?.isIntersecting ?? true;
    if (!inViewport) clearAllPresses();
    else invalidate();
  }, { threshold: 0.02 });
  visibilityObserver.observe(root);

  type StageReceipt = () => Record<string, unknown>;
  const stageGlobal = globalThis as typeof globalThis & {
    __pocketVoxelStageReceipt?: StageReceipt;
  };
  let receipt: StageReceipt | null = null;
  const cleanup = () => {
    if (destroyed) return;
    destroyed = true;
    clearAllPresses();
    resizeObserver.disconnect();
    visibilityObserver.disconnect();
    window.removeEventListener("blur", clearAllPresses);
    controls.removeEventListener("change", invalidate);
    canvas.removeEventListener("pointerdown", onPointerDown, true);
    canvas.removeEventListener("pointerup", onPointerUp, true);
    canvas.removeEventListener("pointercancel", onPointerCancel, true);
    canvas.removeEventListener("lostpointercapture", onLostPointerCapture, true);
    canvas.removeEventListener("pointermove", onPointerMove);
    if (renderRaf) cancelAnimationFrame(renderRaf);
    renderRaf = 0;
    controls.dispose();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const collectResources = (object: THREE.Object3D) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
      }
    };
    scene.traverse(collectResources);
    loadedModel?.traverse(collectResources);
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    texture.dispose();
    renderer.dispose();
    if (receipt && stageGlobal.__pocketVoxelStageReceipt === receipt) {
      delete stageGlobal.__pocketVoxelStageReceipt;
    }
  };

  try {
    const profile = await fetch(PROFILE_URL).then(failResponse).then((response) => response.json()) as StageProfile;
    const view = profile.view ?? {};
    camera.fov = view.fov_y_degrees ?? camera.fov;
    camera.position.fromArray(view.desk_position_mm ?? [0, 10, 285]);
    controls.target.fromArray(view.desk_target_mm ?? [0, 0, 0]);
    stageWidthMm = profile.target_width_mm;
    authoredCameraRadius = camera.position.distanceTo(controls.target);
    camera.updateProjectionMatrix();
    controls.update();

    const modelUrl = new URL(profile.lods.orbit, PROFILE_URL);
    const model = await new GLTFLoader().loadAsync(modelUrl.href);
    loadedModel = model.scene;
    const canonical = canonicalizeModel(model.scene, profile);
    scene.add(canonical);
    bindScreen(canonical, profile, texture);
    proxyGroup = buildPickProxies(profile);
    scene.add(proxyGroup);
    root.dataset.modelReady = "true";
    root.classList.add("is-ready");
    texture.needsUpdate = true;
    resize();
  } catch (error) {
    root.dataset.modelReady = "false";
    root.classList.add("has-error");
    const reason = error instanceof Error ? error : new Error(String(error));
    cleanup();
    options.onError(reason);
    throw reason;
  }

  const api: GameBoyStage = {
    canvas,
    blit() {
      screenFrames += 1;
      root.dataset.screenFrames = String(screenFrames);
      texture.needsUpdate = true;
      invalidate();
    },
    setScreenActionEnabled(enabled: boolean) {
      screenActionEnabled = enabled;
    },
    setRuntimeReady(ready: boolean) {
      root.dataset.runtimeReady = String(ready);
    },
    destroy() {
      cleanup();
    },
  };

  receipt = () => ({
    ready: root.dataset.runtimeReady === "true",
    modelReady: root.dataset.modelReady === "true",
    stageFrames: renderCount,
    screenFrames,
    inputMask: input.mask,
    pressedPart: root.dataset.pressedPart || null,
    controlPoints: Object.fromEntries((proxyGroup?.children ?? []).flatMap((child) => {
      const part = child.userData.stagePart as StagePart | undefined;
      if (!part?.button) return [];
      const point = child.getWorldPosition(new THREE.Vector3()).project(camera);
      const rect = canvas.getBoundingClientRect();
      return [[part.name, {
        x: rect.left + ((point.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - point.y) / 2) * rect.height,
      }]];
    })),
  });
  stageGlobal.__pocketVoxelStageReceipt = receipt;
  return api;
}
