#!/usr/bin/env bun
/**
 * The C half of this crate's verification: cross-build the staticlib, then
 * compile and link `abi_probe.c` against it with devkitARM.
 *
 *   bun crates/pocketvoxel-3ds/abi/check.ts
 *
 * Two things fail here that nothing on the host can catch:
 *
 *  - a struct whose size or field offsets differ on 32-bit ARM from the
 *    numbers `src/tests.rs` asserts (every `_Static_assert` in the probe);
 *  - a header that declares an entry point the archive does not export, or
 *    exports with a different C signature.
 *
 * devkitARM lives in the `devkitpro/devkitarm` image, which is native
 * linux/arm64 on Apple silicon and safe to run concurrently. Nothing is
 * written outside the container's /tmp.
 */
import { $ } from "bun";
import { dirname, resolve } from "node:path";

const IMAGE = "devkitpro/devkitarm:latest";
const crate = resolve(dirname(import.meta.dir));
const crates = dirname(crate);

// The ARM11 in both console revisions, and the ABI libctru is built against
// (brief §0). -mword-relocations is what keeps the 3dsx loader's relocation
// table expressible.
const ARCH = ["-march=armv6k", "-mtune=mpcore", "-mfloat-abi=hard", "-mtp=soft", "-mword-relocations"];

console.log("== cross-building the staticlib ==");
await $`cargo build --release --locked`.cwd(crate);
const lib = `${crate}/target/armv6k-nintendo-3ds/release/libpocketvoxel_3ds.a`;
if (!(await Bun.file(lib).exists())) throw new Error(`missing ${lib}`);

console.log("== compiling + linking abi_probe.c under devkitARM ==");
const script = [
  "set -e",
  "export DEVKITPRO=/opt/devkitpro DEVKITARM=/opt/devkitpro/devkitARM",
  "export PATH=$DEVKITARM/bin:$DEVKITPRO/tools/bin:$PATH",
  [
    "arm-none-eabi-gcc",
    ...ARCH,
    "-std=gnu11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-specs=3dsx.specs",
    "-I/crates/pocketvoxel-3ds/include",
    "-I/crates/pocketvoxel-pica/include",
    "-I$DEVKITPRO/libctru/include",
    "/crates/pocketvoxel-3ds/abi/abi_probe.c",
    "/artifact/libpocketvoxel_3ds.a",
    "-L$DEVKITPRO/libctru/lib",
    "-lctru",
    "-lm",
    "-o /tmp/abi_probe.elf",
  ].join(" "),
  "arm-none-eabi-size /tmp/abi_probe.elf",
].join("\n");

// One argv array, interpolated as data: `sh` here is an argument to `docker`,
// not a command word Bun's shell should resolve on this machine.
const argv = [
  "run",
  "--rm",
  "-v",
  `${crates}:/crates:ro`,
  "-v",
  `${dirname(lib)}:/artifact:ro`,
  IMAGE,
  "sh",
  "-lc",
  script,
];
await $`docker ${argv}`;

console.log("\nABI check passed: every _Static_assert held and every declared entry point linked.");
