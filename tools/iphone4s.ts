import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IPHONE4S_TOOLCHAIN,
  iphone4sCacheRoot,
  iphone4sCsuPath,
  iphone4sQuickJsPath,
  iphone4sSysrootPath,
  inspectIPhone4SToolchain,
} from '../vendor/pocketjs/tools/iphone4s-toolchain.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = 'PocketVoxel.app';
const EXECUTABLE = 'PocketVoxel';
const BUNDLE_ID = 'dev.pocket-stack.voxel.iphone4s';
const INSTALL_PATH = `/Applications/${BUNDLE}`;
const STATUS_PATH = '/private/var/tmp/pocketvoxel-iphone4s.status';
const FRAME_PATH = '/private/var/tmp/pocketvoxel-iphone4s.frame.rgba';
const CAPTURE_PATH = '/private/var/tmp/pocketvoxel-iphone4s.capture';
const AUDIO_STATUS_PATH = '/private/var/tmp/pocketvoxel-iphone4s.audio';
const BUILD_ROOT = join(ROOT, '.pocket-build/iphone4s');
const OUTPUT_ROOT = join(ROOT, 'dist/iphone4s');
const BUNDLE_PATH = join(OUTPUT_ROOT, BUNDLE);
const RECEIPT_PATH = join(BUNDLE_PATH, 'build-receipt.json');
const PAK = join(ROOT, 'dist/voxelmon/voxelmon.vxpak');
const ICON_MASTER = join(ROOT, 'host/iphone4s/art/icon-master.png');
const LAUNCH_MASTER = join(ROOT, 'host/iphone4s/art/launch-master.png');
const ICON_BASENAME = 'PocketVoxelClassic-v1';
const KEY = process.env.POCKETJS_IPHONE4S_KEY ?? join(iphone4sCacheRoot(), 'ssh/id_rsa');
const KNOWN_HOSTS = process.env.POCKETJS_IPHONE4S_KNOWN_HOSTS ?? join(iphone4sCacheRoot(), 'ssh/known_hosts');
const KNOWN_HOST_ALIAS = `[127.0.0.1]:${IPHONE4S_TOOLCHAIN.deployment.localPort}`;

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Receipt {
  schema: 1;
  buildId: string;
  bundleId: string;
  target: string;
  hostAbi: number;
  deploymentTarget: string;
  files: Record<string, string>;
}

function run(command: string, args: readonly string[], cwd = ROOT, env = process.env): CommandResult {
  const result = Bun.spawnSync({ cmd: [command, ...args], cwd, env, stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function mustRun(command: string, args: readonly string[], cwd = ROOT, env = process.env): string {
  const result = run(command, args, cwd, env);
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed (${result.exitCode})${detail ? `:\n${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function buildId(inputs: readonly string[]): string {
  const hash = createHash('sha256');
  for (const path of inputs) {
    const bytes = readFileSync(path);
    const label = path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
    hash.update(`${label.length}:${label}:${bytes.byteLength}:`);
    hash.update(bytes);
  }
  hash.update(`pocketjs:${mustRun('git', ['-C', join(ROOT, 'vendor/pocketjs'), 'rev-parse', 'HEAD'])}`);
  return hash.digest('hex').slice(0, 32);
}

function deviceUdid(): string {
  const requested = process.env.POCKETJS_IPHONE4S_UDID?.trim();
  if (requested) return requested;
  const devices = mustRun('idevice_id', ['-l']).split('\n').map((value) => value.trim()).filter(Boolean);
  if (devices.length !== 1) throw new Error(`expected one USB iPhone, found ${devices.length}`);
  return devices[0];
}

function verifyDevice(): string {
  const udid = deviceUdid();
  const value = (key: string) => mustRun('ideviceinfo', ['-u', udid, '-k', key]);
  const identity = [value('ProductType'), value('HardwareModel'), value('ProductVersion'), value('BuildVersion'), value('ActivationState')];
  const expected = ['iPhone4,1', 'N94AP', '6.1.3', '10B329', 'Activated'];
  if (identity.some((entry, index) => entry !== expected[index])) {
    throw new Error(`refusing device ${identity.join('/')} (expected ${expected.join('/')})`);
  }
  return udid;
}

function sshArgs(port: number, command: string): string[] {
  return [
    '-i', KEY,
    '-p', String(port),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=3',
    '-o', `HostKeyAlias=${KNOWN_HOST_ALIAS}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o', 'HostKeyAlgorithms=+ssh-rsa',
    '-o', 'PubkeyAcceptedAlgorithms=+ssh-rsa',
    'root@127.0.0.1',
    command,
  ];
}

function remote(port: number, command: string): CommandResult {
  return run('ssh', sshArgs(port, command));
}

function mustRemote(port: number, command: string): string {
  const result = remote(port, command);
  if (result.exitCode !== 0) {
    throw new Error(`device command failed (${result.exitCode}):\n${[result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')}`);
  }
  return result.stdout.trim();
}

async function openPort(): Promise<number> {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function withTunnel<T>(operation: (port: number) => Promise<T> | T): Promise<T> {
  const udid = verifyDevice();
  const port = await openPort();
  const tunnel = Bun.spawn({
    cmd: ['iproxy', '-u', udid, `${port}:${IPHONE4S_TOOLCHAIN.deployment.devicePort}`],
    cwd: ROOT,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  try {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await Bun.sleep(200);
      if (remote(port, 'true').exitCode === 0) return await operation(port);
      if (tunnel.exitCode !== null) break;
    }
    const stderr = await new Response(tunnel.stderr as ReadableStream).text();
    throw new Error(`USB SSH tunnel did not become ready${stderr ? `:\n${stderr}` : ''}`);
  } finally {
    if (tunnel.exitCode === null) tunnel.kill();
    await tunnel.exited;
  }
}

async function bakeArtwork(): Promise<void> {
  const font = join(ROOT, 'vendor/pocketjs/assets/fonts/InterDisplay-Bold.ttf');
  for (const [name, geometry] of [[`${ICON_BASENAME}.png`, '57x57'], [`${ICON_BASENAME}@2x.png`, '114x114']] as const) {
    mustRun('magick', [
      ICON_MASTER, '-colorspace', 'sRGB', '-filter', 'Lanczos', '-resize', `${geometry}!`,
      '-unsharp', '0x0.55+0.55+0.02', '-strip', '-depth', '8', join(BUNDLE_PATH, name),
    ]);
  }

  const launch = join(BUILD_ROOT, 'launch-640x960.png');
  mustRun('magick', [
    LAUNCH_MASTER, '-colorspace', 'sRGB', '-filter', 'Lanczos', '-resize', '640x960!',
    '-font', font, '-gravity', 'north',
    '-pointsize', '48', '-fill', '#08060acc', '-annotate', '+0+105', 'POCKET VOXEL',
    '-fill', '#f2ede7', '-annotate', '+0+101', 'POCKET VOXEL',
    '-pointsize', '18', '-fill', '#0b080dcc', '-annotate', '+0+169', 'A WORLD IN YOUR POCKET',
    '-fill', '#c8b8cb', '-annotate', '+0+166', 'A WORLD IN YOUR POCKET',
    '-strip', '-depth', '8', launch,
  ]);
  cpSync(launch, join(BUNDLE_PATH, 'Default@2x.png'));
  mustRun('magick', [
    launch, '-gravity', 'center', '-background', '#100c12', '-extent', '640x1136',
    '-strip', '-depth', '8', join(BUNDLE_PATH, 'Default-568h@2x.png'),
  ]);
}

function bakeControlTextures(): Record<string, string> {
  const motions = join(ROOT, 'vendor/pocketjs/apps/motions');
  const font = join(ROOT, 'vendor/pocketjs/assets/fonts/InterDisplay-Bold.ttf');
  const output = (name: string) => join(BUILD_ROOT, `${name}.rgba`);
  if (!existsSync(join(motions, 'letter-a.svg')) || !existsSync(join(motions, 'letter-b.svg'))) {
    throw new Error('PocketJS Motion Lab baked-letter references are missing');
  }
  const bakeLabel = (name: string, label: string, width: number, height: number, pointSize: number, color = '#f1f1f1') => {
    const path = output(name);
    mustRun('magick', [
      '-size', `${width}x${height}`, 'xc:none', '-font', font, '-pointsize', String(pointSize),
      '-fill', color, '-gravity', 'center', '-annotate', '+0+0', label,
      '-depth', '8', `RGBA:${path}`,
    ]);
    if (readFileSync(path).byteLength !== width * height * 4) throw new Error(`${name} texture has the wrong size`);
    return path;
  };
  const bakeImage = (name: string, source: string, width: number, height: number) => {
    const path = output(name);
    mustRun('magick', [
      source, '-colorspace', 'sRGB', '-filter', 'Lanczos', '-resize', `${width}x${height}!`,
      '-depth', '8', `RGBA:${path}`,
    ]);
    if (readFileSync(path).byteLength !== width * height * 4) throw new Error(`${name} texture has the wrong size`);
    return path;
  };
  const dpadSource = join(ROOT, 'host/iphone4s/dpad.svg');
  const bakeDpad = (name: string, perspective?: string) => {
    const path = output(name);
    const args = ['-background', 'none', dpadSource, '-alpha', 'on', '-resize', '256x256!'];
    if (perspective) {
      args.push(
        '-define', 'distort:viewport=256x256+0+0', '-virtual-pixel', 'transparent',
        '-distort', 'Perspective', perspective,
      );
    }
    args.push('-depth', '8', `RGBA:${path}`);
    mustRun('magick', args);
    if (readFileSync(path).byteLength !== 256 * 256 * 4) throw new Error(`${name} texture has the wrong size`);
    return path;
  };
  return {
    POCKETVOXEL_LETTER_A: bakeLabel('letter-a', 'A', 64, 64, 52),
    POCKETVOXEL_LETTER_B: bakeLabel('letter-b', 'B', 64, 64, 52),
    POCKETVOXEL_SELECT_LABEL: bakeLabel('select-label', 'SELECT', 80, 24, 16),
    POCKETVOXEL_START_LABEL: bakeLabel('start-label', 'START', 80, 24, 16),
    POCKETVOXEL_MOTION_CREDIT: bakeLabel('motion-credit', '(yui540)', 96, 18, 13),
    POCKETVOXEL_MENU_LABEL: bakeLabel('menu-label', 'MENU', 80, 24, 16),
    POCKETVOXEL_POPUP_TITLE: bakeLabel('popup-title', 'POCKET VOXEL', 360, 52, 34),
    POCKETVOXEL_POPUP_SUBTITLE: bakeLabel('popup-subtitle', 'A WORLD IN YOUR POCKET', 320, 30, 17, '#514557'),
    POCKETVOXEL_POPUP_CREDIT: bakeLabel('popup-credit', 'MOTION STUDIES BY yui540', 320, 30, 16, '#514557'),
    POCKETVOXEL_DONE_LABEL: bakeLabel('done-label', 'DONE', 96, 28, 18),
    POCKETVOXEL_POPUP_ICON: bakeImage('popup-icon', ICON_MASTER, 112, 112),
    POCKETVOXEL_DPAD_IDLE: bakeDpad('dpad-idle'),
    POCKETVOXEL_DPAD_UP: bakeDpad('dpad-up', '0,0 6,7 255,0 249,7 0,255 0,252 255,255 255,252'),
    POCKETVOXEL_DPAD_RIGHT: bakeDpad('dpad-right', '0,0 4,0 255,0 248,6 0,255 4,255 255,255 248,249'),
    POCKETVOXEL_DPAD_DOWN: bakeDpad('dpad-down', '0,0 0,4 255,0 255,4 0,255 6,248 255,255 249,248'),
    POCKETVOXEL_DPAD_LEFT: bakeDpad('dpad-left', '0,0 7,6 255,0 252,0 0,255 7,249 255,255 252,255'),
  };
}

function writeAudioToolboxStub(): string {
  const frameworkRoot = join(BUILD_ROOT, 'Frameworks/AudioToolbox.framework');
  const output = join(frameworkRoot, 'AudioToolbox.tbd');
  const symbols = [
    '_AudioQueueAllocateBuffer', '_AudioQueueDispose', '_AudioQueueEnqueueBuffer',
    '_AudioQueueNewOutput', '_AudioQueueStart', '_AudioQueueStop',
    '_AudioSessionInitialize', '_AudioSessionSetActive', '_AudioSessionSetProperty',
  ];
  mkdirSync(frameworkRoot, { recursive: true });
  writeFileSync(output, [
    '--- !tapi-tbd',
    'tbd-version: 4',
    'targets: [ armv7-ios ]',
    'install-name: "/System/Library/Frameworks/AudioToolbox.framework/AudioToolbox"',
    'exports:',
    '  - targets: [ armv7-ios ]',
    `    symbols: [ ${symbols.map((symbol) => JSON.stringify(symbol)).join(', ')} ]`,
    '...',
    '',
  ].join('\n'));
  return join(BUILD_ROOT, 'Frameworks');
}

async function build(): Promise<void> {
  const toolchain = inspectIPhone4SToolchain();
  if (!toolchain.sysroot || !toolchain.csu || !toolchain.quickjs) {
    throw new Error('validated PocketJS iPhone 4S toolchain is incomplete; run `bun iphone4s doctor`');
  }
  if (!existsSync(PAK)) throw new Error('VXPK is missing; run ROM import and cook first');
  rmSync(BUILD_ROOT, { recursive: true, force: true });
  rmSync(BUNDLE_PATH, { recursive: true, force: true });
  mkdirSync(BUILD_ROOT, { recursive: true });
  mkdirSync(BUNDLE_PATH, { recursive: true });
  const controlTextures = bakeControlTextures();
  const compatibilityFrameworks = writeAudioToolboxStub();

  const guest = join(BUILD_ROOT, 'voxelmon.js');
  mustRun('bun', ['build', 'voxelmon/game/psp-main.ts', '--outfile', guest, '--format=iife', '--target=browser', '--minify-syntax']);

  const clang = mustRun('xcrun', ['--find', 'clang']);
  const linker = mustRun('xcrun', ['--find', IPHONE4S_TOOLCHAIN.compiler.linker]);
  const macosSdk = mustRun('xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
  const sysroot = iphone4sSysrootPath();
  const csu = iphone4sCsuPath();
  const quickjs = join(iphone4sQuickJsPath(), 'libquickjs-sys/embed/quickjs');
  const common = [
    '-target', 'armv7-apple-ios6.0',
    `-miphoneos-version-min=${IPHONE4S_TOOLCHAIN.compiler.minimumVersion}`,
    '-march=armv7', '-Os', '-fno-stack-protector', '-fno-builtin', '-fno-common',
    '-fwrapv', '-funsigned-char', '-U_FORTIFY_SOURCE', '-D_FORTIFY_SOURCE=0',
    '-isysroot', macosSdk,
  ];
  const warnings = ['-Wall', '-Wextra', '-Werror', '-Wno-incompatible-sysroot'];
  const compile = (source: string, output: string, extra: readonly string[] = []) =>
    mustRun(clang, [...common, ...extra, '-c', source, '-o', output]);

  compile(join(csu, 'start.s'), join(BUILD_ROOT, 'csu-start.o'), ['-x', 'assembler-with-cpp']);
  compile(join(csu, 'dyld_glue.s'), join(BUILD_ROOT, 'csu-dyld-glue.o'), ['-x', 'assembler-with-cpp', '-DMACH_HEADER_SYMBOL_NAME=__mh_execute_header', '-DCRT']);

  const quickJsObjects: string[] = [];
  for (const source of ['quickjs.c', 'cutils.c', 'dtoa.c', 'libregexp.c', 'libunicode.c']) {
    const output = join(BUILD_ROOT, `quickjs-${source.replace(/\.c$/, '')}.o`);
    compile(join(quickjs, source), output, ['-I', quickjs, `-DCONFIG_VERSION=\"${IPHONE4S_TOOLCHAIN.compiler.quickJsVersion}\"`]);
    quickJsObjects.push(output);
  }

  const rustup = Bun.which('rustup');
  if (!rustup) throw new Error('rustup is unavailable');
  const cargo = mustRun(rustup, ['which', '--toolchain', IPHONE4S_TOOLCHAIN.compiler.rustToolchain, 'cargo']);
  const rustc = mustRun(rustup, ['which', '--toolchain', IPHONE4S_TOOLCHAIN.compiler.rustToolchain, 'rustc']);
  const rustTarget = join(BUILD_ROOT, 'rust-target');
  const cargoHome = join(iphone4sCacheRoot(), 'build/cargo-home');
  mkdirSync(cargoHome, { recursive: true });
  mustRun(cargo, [
    'build', '--release', '--locked',
    '--target', join(ROOT, 'vendor/pocketjs/hosts/iphone4s/armv7-apple-ios.json'),
    '-Z', 'json-target-spec',
    '-Z', 'build-std=core,alloc,compiler_builtins',
    '-Z', 'build-std-features=compiler-builtins-mem',
  ], join(ROOT, 'crates/pocketvoxel-iphone4s'), {
    ...process.env,
    RUSTC: rustc,
    CARGO_HOME: cargoHome,
    CARGO_TARGET_DIR: rustTarget,
    IPHONEOS_DEPLOYMENT_TARGET: IPHONE4S_TOOLCHAIN.compiler.minimumVersion,
    ...controlTextures,
  });
  const rustLibrary = join(rustTarget, 'armv7-apple-ios/release/libpocketvoxel_iphone4s.a');
  if (!existsSync(rustLibrary)) throw new Error(`missing ${rustLibrary}`);

  const crt = join(BUILD_ROOT, 'crt_globals.o');
  const compat = join(BUILD_ROOT, 'compat.o');
  const pocketRuntime = join(BUILD_ROOT, 'pocket_runtime.o');
  compile(join(ROOT, 'vendor/pocketjs/hosts/iphone2g/crt_globals.c'), crt, warnings);
  compile(join(ROOT, 'vendor/pocketjs/hosts/iphone2g/compat.c'), compat, warnings);
  compile(join(ROOT, 'host/iphone4s/pocket_runtime.c'), pocketRuntime, [
    ...warnings,
    '-Wno-cast-function-type-mismatch',
    '-isystem', quickjs,
  ]);

  cpSync(join(ROOT, 'host/iphone4s/Info.plist'), join(BUNDLE_PATH, 'Info.plist'));
  cpSync(join(ROOT, 'host/iphone4s/PkgInfo'), join(BUNDLE_PATH, 'PkgInfo'));
  await bakeArtwork();

  const runtimeIdentity = join(BUILD_ROOT, 'runtime.identity.o');
  const firstParty = [...warnings, '-DPOCKET_LOGICAL_WIDTH=320', '-DPOCKET_LOGICAL_HEIGHT=480', '-DPOCKET_RASTER_DENSITY=2', '-Wno-cast-function-type-mismatch'];
  compile(join(ROOT, 'host/iphone4s/runtime.c'), runtimeIdentity, [...firstParty, '-DPOCKET_BUILD_ID=\"00000000000000000000000000000000\"']);
  const identity = buildId([
    guest, PAK,
    join(ROOT, 'host/iphone4s/runtime.c'),
    join(ROOT, 'host/iphone4s/pocket_runtime.c'),
    join(ROOT, 'host/iphone4s/Info.plist'),
    join(ROOT, 'host/iphone4s/dpad.svg'),
    ICON_MASTER,
    LAUNCH_MASTER,
    join(ROOT, 'tools/iphone4s.ts'),
    join(ROOT, 'crates/pocketvoxel-iphone4s/src/lib.rs'),
    join(ROOT, 'crates/pocketvoxel-iphone4s/src/gles1.rs'),
    rustLibrary, runtimeIdentity, pocketRuntime,
    ...quickJsObjects,
  ]);
  const runtime = join(BUILD_ROOT, 'runtime.o');
  compile(join(ROOT, 'host/iphone4s/runtime.c'), runtime, [...firstParty, `-DPOCKET_BUILD_ID=\"${identity}\"`]);

  const embeddedGuest = join(BUILD_ROOT, 'voxelmon.js.bin');
  writeFileSync(embeddedGuest, Buffer.concat([readFileSync(guest), Buffer.from([0])]));
  const executable = join(BUNDLE_PATH, EXECUTABLE);
  mustRun(linker, [
    '-arch', 'armv7', '-syslibroot', sysroot, '-L/usr/lib', `-F${compatibilityFrameworks}`, '-F/System/Library/Frameworks',
    '-iphoneos_version_min', IPHONE4S_TOOLCHAIN.compiler.minimumVersion,
    '-no_pie', '-no_uuid', '-no_function_starts', '-no_data_in_code_info', '-no_source_version',
    '-no_compact_unwind', '-no_adhoc_codesign', '-no_encryption', '-e', 'start', '-o', executable,
    join(BUILD_ROOT, 'csu-start.o'), join(BUILD_ROOT, 'csu-dyld-glue.o'), crt,
    runtime, pocketRuntime, compat, '-force_load', rustLibrary, ...quickJsObjects,
    '-sectcreate', '__DATA', '__pocket_js', embeddedGuest,
    '-sectalign', '__DATA', '__pocket_pak', '0x10',
    '-sectcreate', '__DATA', '__pocket_pak', PAK,
    '-framework', 'UIKit', '-framework', 'Foundation', '-framework', 'CoreGraphics', '-framework', 'OpenGLES',
    '-framework', 'AudioToolbox',
    '-lobjc', '-lSystem', '-lgcc_s.1',
  ]);
  chmodSync(executable, 0o755);
  mustRun('ldid', ['-S', executable]);
  mustRun('plutil', ['-lint', join(BUNDLE_PATH, 'Info.plist')]);
  const fileInfo = mustRun('file', [executable]);
  if (!fileInfo.includes('Mach-O executable arm_v7')) throw new Error(`unexpected binary: ${fileInfo}`);
  const loads = mustRun('xcrun', ['otool-classic', '-l', executable]);
  for (const marker of ['LC_VERSION_MIN_IPHONEOS', 'version 6.0', 'sectname __pocket_js', 'sectname __pocket_pak', 'LC_CODE_SIGNATURE']) {
    if (!loads.includes(marker)) throw new Error(`binary is missing ${marker}`);
  }

  const names = [
    EXECUTABLE, 'Info.plist', 'PkgInfo', `${ICON_BASENAME}.png`, `${ICON_BASENAME}@2x.png`,
    'Default@2x.png', 'Default-568h@2x.png',
  ];
  const receipt: Receipt = {
    schema: 1,
    buildId: identity,
    bundleId: BUNDLE_ID,
    target: 'iphone4s-ios6-armv7',
    hostAbi: 2,
    deploymentTarget: IPHONE4S_TOOLCHAIN.compiler.minimumVersion,
    files: Object.fromEntries(names.map((name) => [name, sha256(join(BUNDLE_PATH, name))])),
  };
  writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2) + '\n');
  console.log(`built ${BUNDLE_PATH}`);
  console.log(fileInfo);
  console.log(`build_id=${identity}`);
}

function receipt(): Receipt {
  if (!existsSync(RECEIPT_PATH)) throw new Error('no built app; run `bun iphone4s build`');
  return JSON.parse(readFileSync(RECEIPT_PATH, 'utf8')) as Receipt;
}

function verifyInstalled(port: number, expected: Receipt): void {
  const actual = JSON.parse(mustRemote(port, `cat ${INSTALL_PATH}/build-receipt.json`)) as Receipt;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('installed receipt does not match local build');
}

async function deploy(): Promise<void> {
  await build();
  const expected = receipt();
  const transaction = randomBytes(12).toString('hex');
  const archive = join(BUILD_ROOT, `${BUNDLE}-${transaction}.tar`);
  const remoteArchive = `/private/var/tmp/pocketvoxel-${transaction}.tar`;
  const stage = `/Applications/.PocketVoxel.app.stage-${transaction}`;
  const backup = `/Applications/.PocketVoxel.app.backup-${transaction}`;
  const unpack = `/Applications/.PocketVoxel.app.unpack-${transaction}`;
  mustRun('tar', ['-cf', archive, '-C', OUTPUT_ROOT, BUNDLE], ROOT, { ...process.env, COPYFILE_DISABLE: '1' });
  try {
    await withTunnel(async (port) => {
      mustRun('scp', [
        '-O', '-i', KEY, '-P', String(port),
        '-o', 'BatchMode=yes', '-o', `HostKeyAlias=${KNOWN_HOST_ALIAS}`,
        '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
        '-o', 'HostKeyAlgorithms=+ssh-rsa', '-o', 'PubkeyAcceptedAlgorithms=+ssh-rsa',
        archive, `root@127.0.0.1:${remoteArchive}`,
      ]);
      let operationError: unknown;
      try {
        mustRemote(port,
          `set -eu; rm -rf ${stage} ${unpack}; mkdir -p ${unpack}; tar -xf ${remoteArchive} -C ${unpack}; ` +
          `test -d ${unpack}/${BUNDLE}; mv ${unpack}/${BUNDLE} ${stage}; rmdir ${unpack}; ` +
          `test -x ${stage}/${EXECUTABLE}; /usr/bin/ldid -e ${stage}/${EXECUTABLE} >/dev/null`);
        const expectedFiles = { ...expected.files, 'build-receipt.json': sha256(RECEIPT_PATH) };
        const names = Object.keys(expectedFiles);
        const lines = mustRemote(port, `cd ${stage} && for file in ${names.join(' ')}; do /usr/bin/openssl dgst -sha256 \"$file\"; done`);
        const remoteHashes = new Map(lines.split('\n').map((line) => {
          const match = line.match(/^SHA256\((.+)\)= ([0-9a-f]{64})$/);
          if (!match) throw new Error(`malformed device hash: ${line}`);
          return [match[1], match[2]];
        }));
        for (const [name, hash] of Object.entries(expectedFiles)) {
          if (remoteHashes.get(name) !== hash) throw new Error(`device readback mismatch for ${name}`);
        }
        mustRemote(port,
          `set -eu; dest=${INSTALL_PATH}; stage=${stage}; backup=${backup}; ` +
          `killall ${EXECUTABLE} 2>/dev/null || true; ` +
          `rollback() { status=$?; trap - EXIT HUP INT TERM; set +e; ` +
          `test -e \"$dest\" && rm -rf \"$dest\"; test -e \"$backup\" && mv \"$backup\" \"$dest\"; exit \"$status\"; }; ` +
          `trap rollback EXIT HUP INT TERM; test ! -e \"$backup\"; ` +
          `if test -e \"$dest\"; then mv \"$dest\" \"$backup\"; fi; mv \"$stage\" \"$dest\"; ` +
          `chown -R root:wheel \"$dest\"; chmod 755 \"$dest/${EXECUTABLE}\"; ` +
          `/usr/bin/ldid -e \"$dest/${EXECUTABLE}\" >/dev/null; /bin/su mobile -c /usr/bin/uicache; ` +
          `trap - EXIT HUP INT TERM; rm -rf \"$backup\"; echo installed-${transaction}`);
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        const cleanup = remote(port, `rm -rf ${stage} ${unpack} ${remoteArchive}`);
        if (cleanup.exitCode !== 0 && operationError === undefined) throw new Error(`device cleanup failed: ${cleanup.stderr}`);
      }
    });
  } finally {
    rmSync(archive, { force: true });
  }
  console.log(`deployed ${expected.buildId} to ${INSTALL_PATH} with byte-exact readback`);
}

function parseStatus(raw: string): Record<string, string> {
  return Object.fromEntries(raw.trim().split('\n').map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function status(requireAction = false): Promise<Record<string, string>> {
  const expected = receipt();
  return await withTunnel(async (port) => {
    verifyInstalled(port, expected);
    const first = parseStatus(mustRemote(port, `cat ${STATUS_PATH}`));
    const firstAudio = parseStatus(mustRemote(port, `cat ${AUDIO_STATUS_PATH}`));
    await Bun.sleep(1300);
    const current = parseStatus(mustRemote(port, `cat ${STATUS_PATH}`));
    const audio = parseStatus(mustRemote(port, `cat ${AUDIO_STATUS_PATH}`));
    if (current.schema !== '2' || current.build_id !== expected.buildId || current.state !== 'running' || current.error !== '') {
      throw new Error(`runtime is not healthy: ${JSON.stringify(current)}`);
    }
    if (current.renderer !== 'gles1' || current.raster_density !== '2' || current.drawable_width !== '640' || current.drawable_height !== '960') {
      throw new Error(`expected GLES1 Retina 640x960, got ${current.renderer} ${current.drawable_width}x${current.drawable_height}`);
    }
    if (Number(current.guest_frames) <= Number(first.guest_frames) || Number(current.heartbeat) <= Number(first.heartbeat)) {
      throw new Error('guest heartbeat did not advance');
    }
    if (audio.audio_state !== 'running' || audio.audio_error !== '' ||
        Number(audio.audio_callbacks) <= Number(firstAudio.audio_callbacks) || Number(audio.audio_frames) <= 0 ||
        Number(audio.audio_nonzero_buffers) <= 0 || Number(audio.audio_peak) <= 0) {
      throw new Error(`native audio is not advancing: ${JSON.stringify(audio)}`);
    }
    mustRemote(port, `kill -0 ${current.pid}`);
    if (requireAction && (current.action_name !== 'voxel_input' || Number(current.action_sequence) < 1 || Number(current.completed_touch_sequences) < 1)) {
      throw new Error('no completed Pocket Voxel control touch has been observed yet');
    }
    const accepted = { ...current, ...audio };
    console.log(JSON.stringify(accepted, null, 2));
    return accepted;
  });
}

async function launch(): Promise<void> {
  const expected = receipt();
  await withTunnel(async (port) => {
    verifyInstalled(port, expected);
    mustRemote(port,
      `killall ${EXECUTABLE} 2>/dev/null || true; rm -f ${STATUS_PATH} ${FRAME_PATH} ${CAPTURE_PATH} ${AUDIO_STATUS_PATH}; ` +
      `/bin/su mobile -c '/usr/bin/uiopen pocketvoxel://launch'; echo launch-requested`);
    await Bun.sleep(2500);
  });
  await status(false);
}

async function capture(): Promise<void> {
  const raw = join(OUTPUT_ROOT, 'device-frame.rgba');
  const png = join(OUTPUT_ROOT, 'device-frame.png');
  rmSync(raw, { force: true });
  rmSync(png, { force: true });
  await withTunnel(async (port) => {
    const current = parseStatus(mustRemote(port, `cat ${STATUS_PATH}`));
    if (current.renderer !== 'gles1' || current.drawable_width !== '640' || current.drawable_height !== '960') {
      throw new Error('refusing a non-Retina GLES1 capture');
    }
    try {
      mustRemote(port, `rm -f ${FRAME_PATH} ${CAPTURE_PATH}; /bin/su mobile -c 'touch ${CAPTURE_PATH}'`);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await Bun.sleep(200);
        if (remote(port, `test -s ${FRAME_PATH}`).exitCode === 0) break;
      }
      mustRemote(port, `test -s ${FRAME_PATH}`);
      const result = Bun.spawnSync({ cmd: ['ssh', ...sshArgs(port, `cat ${FRAME_PATH}`)], cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      if (result.exitCode !== 0) throw new Error(`frame download failed: ${result.stderr.toString()}`);
      writeFileSync(raw, result.stdout);
    } finally {
      remote(port, `rm -f ${CAPTURE_PATH} ${FRAME_PATH}`);
    }
  });
  if (readFileSync(raw).byteLength !== 640 * 960 * 4) throw new Error('captured frame length is wrong');
  mustRun('magick', ['-size', '640x960', '-depth', '8', `rgba:${raw}`, '-flip', png]);
  console.log(`${mustRun('file', [png])}\n${png}`);
}

function usage(): void {
  console.log(`Pocket Voxel iPhone 4S tool

  bun iphone4s doctor
  bun iphone4s build
  bun iphone4s deploy
  bun iphone4s launch
  bun iphone4s status [--require-action]
  bun iphone4s capture`);
}

export async function main(args = Bun.argv.slice(2)): Promise<void> {
  switch (args[0] ?? 'doctor') {
    case 'doctor':
      console.log(mustRun('bun', ['tools/iphone4s.ts', 'doctor'], join(ROOT, 'vendor/pocketjs')));
      break;
    case 'build': await build(); break;
    case 'deploy': await deploy(); break;
    case 'launch': await launch(); break;
    case 'status': await status(args.includes('--require-action')); break;
    case 'capture': await capture(); break;
    case 'help': case '--help': case '-h': usage(); break;
    default: usage(); throw new Error(`unknown command ${args[0]}`);
  }
}

if (import.meta.main) await main();
