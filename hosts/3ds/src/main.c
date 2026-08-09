/*
 * Pocket Voxel on the Nintendo 3DS: the diorama through the PICA200 instead
 * of a software rasterizer.
 *
 * Per tick, the shape crates/pocketvoxel-psp/src/main.rs drives:
 *
 *   hidScanInput -> globalThis.frame(buttons) in QuickJS -> drain microtasks
 *   -> pv3_tick (Scene::tick, fixed 60 Hz) -> pv3_record (draw::build + the
 *   PICA lowering) -> C3D_FrameBegin / clear / FrameDrawOn / SetViewport ->
 *   the command walk -> C3D_FrameEnd.
 *
 * The render target is created ROTATED — 240 wide by 400 tall — which is how
 * the top screen's framebuffer is laid out; voxel_gfx.c pre-multiplies the
 * screen tilt over the crate's matrix table so the diorama's own landscape
 * coordinates survive.
 *
 * The pak is 480x272 by META and is NOT re-cooked for this screen: VIEW_W and
 * VIEW_H also fix the camera aspect, the UI scale and the sky horizon row. It
 * renders through the existing camera into a 400x226 letterboxed viewport on
 * the 400x240 top screen, which preserves the cooked aspect exactly and costs
 * 7 px of bar top and bottom. The bars carry the sky pass's own clear colour,
 * because that clear covers the whole framebuffer.
 *
 * Every step of that loop names itself in `voxel_host_stage` before it runs,
 * and the two waits the frame makes on the GPU carry deadlines rather than
 * blocking forever. A run that stops therefore leaves a stage, a tick and a
 * set of counters behind — in sdmc:/pocketvoxel-3ds/hb.txt while it is still
 * running, and in the error file if a deadline expires.
 *
 * Building with -DPV3DS_CAPTURE turns this into the deterministic e2e binary:
 * input comes from a baked tape instead of the hardware, only the mark ticks
 * render, each mark's render target is read back into
 * sdmc:/pocketvoxel-3ds/fNNNN.raw, and the process parks instead of exiting
 * so the emulator stays alive for the driver to kill.
 */

#include <3ds.h>
#include <citro3d.h>
#include <malloc.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "input.h"
#include "pocketvoxel_3ds.h"
#include "pocketvoxel_pica.h"
#include "qjs.h"
#include "voxel_gfx.h"

/* The top screen. The render target is created (height, width) — rotated. */
#define TOP_SCREEN_W 400
#define TOP_SCREEN_H 240
#define CAPTURE_BYTES ((size_t)TOP_SCREEN_W * TOP_SCREEN_H * 4)

/* Everything the guest needs, staged into the .3dsx's RomFS by the Makefile.
 * RomFS rather than the SD card: one file to install, and the driver cannot
 * accidentally run against a stale pak sitting next to a fresh binary. */
#define PAK_PATH "romfs:/voxelmon.vxpak"
#define GUEST_PATH "romfs:/game.js"

/*
 * Memory. Every number here is a build-time knob because the split that fits
 * depends on the console revision and on how much the launcher kept, and
 * getting it wrong is a boot failure rather than a slow frame. All of them are
 * PV3DS_HOST_* so they cannot collide with the crate's own PV3DS_* contract
 * values.
 *
 *   ARENA_MIB     the staging arena, split into ARENA_BANKS banks. 0 means
 *                 PV3DS_ARENA_BYTES — the crate's own budget, two banks of
 *                 6 MiB, which is what pocketvoxel-pica was sized against: the
 *                 worst sampled story frame is ~70k triangles at the shipped
 *                 rung, and a 140k-triangle frame is ~4.7 MB of vertices plus
 *                 ~0.9 MB of indices.
 *   ARENA_BANKS   0 means PV3DS_ARENA_BANKS. Two is what makes the rewind
 *                 safe: a present rewinds one bank, so with two banks and a
 *                 loop whose C3D_FrameBegin waits for the command queue to
 *                 drain (frame_begin_bounded below), the bank being rewound is
 *                 two frames old and the GPU is provably done.
 *   TEXTURE_MIB   linear memory held back for the expanded texture set. The
 *                 whole reachable set is 541 textures / 12.70 MiB, measured
 *                 over the shipped pak, and nothing is ever evicted.
 *   HEAP_MIB      libctru's application heap, and LINEAR_MIB its linear heap.
 *                 Both zero is the stock automatic split; the boot log prints
 *                 what it actually got. They are set together or not at all —
 *                 libctru only takes the automatic path when NEITHER is
 *                 given, so a lone override leaves the other heap at zero.
 */
#ifndef PV3DS_HOST_ARENA_MIB
#define PV3DS_HOST_ARENA_MIB 0
#endif
#ifndef PV3DS_HOST_ARENA_BANKS
#define PV3DS_HOST_ARENA_BANKS 0
#endif
#ifndef PV3DS_HOST_TEXTURE_MIB
#define PV3DS_HOST_TEXTURE_MIB 14
#endif
#ifndef PV3DS_HOST_HEAP_MIB
#define PV3DS_HOST_HEAP_MIB 0
#endif
#ifndef PV3DS_HOST_LINEAR_MIB
#define PV3DS_HOST_LINEAR_MIB 0
#endif
/*
 * The GPU command buffer. A voxel frame issues several hundred draws, each
 * carrying a matrix upload and its own buffer configuration, which is an
 * order of magnitude more command words than the 400x240 UI this host's
 * PocketJS sibling submits — so the citro3d default is multiplied rather than
 * inherited.
 */
#ifndef PV3DS_HOST_CMDBUF_BYTES
#define PV3DS_HOST_CMDBUF_BYTES (C3D_DEFAULT_CMDBUF_SIZE * 4)
#endif

#define MIB(n) ((uint32_t)(n) * 1024u * 1024u)
/* Below this an arena cannot hold one outdoor frame, and a run that quietly
 * drops half the world is worse than one that says why it will not start. */
#define ARENA_FLOOR MIB(2)

#define ARENA_WANT \
  (PV3DS_HOST_ARENA_MIB ? MIB(PV3DS_HOST_ARENA_MIB) : (uint32_t)PV3DS_ARENA_BYTES)
#define ARENA_BANKS \
  (PV3DS_HOST_ARENA_BANKS ? (uint32_t)PV3DS_HOST_ARENA_BANKS : (uint32_t)PV3DS_ARENA_BANKS)

/*
 * libctru reads these weak symbols at startup. Both zero is exactly the stock
 * automatic split; a non-zero pair takes it over, which is how a 30.6 MiB pak
 * plus ~25 MiB of linear memory gets arranged by hand when the automatic
 * split does not fit it.
 */
u32 __ctru_heap_size = MIB(PV3DS_HOST_HEAP_MIB);
u32 __ctru_linear_heap_size = MIB(PV3DS_HOST_LINEAR_MIB);

/*
 * The 3dsx crt0 gives the main thread 32 KiB of stack. QuickJS's interpreter
 * recurses, and so does the JSON.parse of the pak's 1.15 MB GAME section at
 * boot, so the default is far too small.
 */
unsigned int __stacksize__ = 1024 * 1024;

static C3D_RenderTarget *target;

static const u32 DISPLAY_TRANSFER_FLAGS =
  GX_TRANSFER_FLIP_VERT(0) | GX_TRANSFER_OUT_TILED(0) | GX_TRANSFER_RAW_COPY(0) |
  GX_TRANSFER_IN_FORMAT(GX_TRANSFER_FMT_RGBA8) |
  GX_TRANSFER_OUT_FORMAT(GX_TRANSFER_FMT_RGB8) |
  GX_TRANSFER_SCALING(GX_TRANSFER_SCALE_NO);

// ---------------------------------------------------------------------------
// capture build (the deterministic e2e binary)
// ---------------------------------------------------------------------------

#ifdef PV3DS_CAPTURE

#ifndef PV3DS_CAPTURE_INPUT
#define PV3DS_CAPTURE_INPUT ""
#endif
#ifndef PV3DS_CAPTURE_MARKS
#define PV3DS_CAPTURE_MARKS ""
#endif

/* Everything the driver reads lives in one directory it deletes before every
 * run: Azahar has no working per-run isolation, so a previous run's files
 * would otherwise satisfy the count check and stale pixels get compared. */
#define CAPTURE_DIR "sdmc:/pocketvoxel-3ds"

/* The PPF's own RGB8 staging buffer, and the A,B,G,R buffer the file holds. */
#define CAPTURE_RGB_BYTES ((size_t)TOP_SCREEN_W * TOP_SCREEN_H * 3)

static const char CAPTURE_INPUT[] = PV3DS_CAPTURE_INPUT;
static const char CAPTURE_MARKS[] = PV3DS_CAPTURE_MARKS;
static u32 *capture_buffer;
static u8 *capture_rgb;

#endif /* PV3DS_CAPTURE */

/* Where the memory report lands. In a capture build it belongs inside the
 * directory the driver wipes before every run; a playable build writes beside
 * its error file. */
#ifdef PV3DS_CAPTURE
#define REPORT_PATH CAPTURE_DIR "/memory.txt"
#else
#define REPORT_PATH "sdmc:/pocketvoxel-3ds-memory.txt"
#endif

// ---------------------------------------------------------------------------
// the stage breadcrumb and the heartbeat
// ---------------------------------------------------------------------------

/*
 * What a run that stops leaves behind.
 *
 * A wedged run is not an erroring run: fail() never happens, so no error file
 * is written, the top screen keeps its last frame, and the bottom screen's
 * counter line only refreshes every 30 ticks — a run that stops inside the
 * first 30 says nothing at all about where it stopped.
 *
 * Two cheap things fix that.
 *
 *   THE STAGE is a plain store into a global before each step of the frame:
 *   no syscall, no formatting, no file. A debugger attached to a halted
 *   console reads it directly (`p voxel_host_stage`, `p voxel_host_tick`).
 *   voxel_host_tick is the HOST's tick counter, which is the frame number;
 *   the Scene's own clock is reported next to it.
 *
 *   THE HEARTBEAT spends one truncating SD write to put the same facts in a
 *   file a harness can read over FTP with no debugger at all:
 *   sdmc:/pocketvoxel-3ds/hb.txt, one line, rewritten in place. This is the
 *   PSP capture path's mechanism (crates/pocketvoxel-psp/src/capture.rs
 *   heartbeat()) with the stage and the frame's counters added.
 *
 * A write costs an SD round trip, so writing on every stage change does not
 * hold 60 Hz. That is the trade this build makes: PV3DS_HOST_HEARTBEAT=0
 * turns the file off entirely and leaves the stage store, which is free.
 *
 *   PV3DS_HOST_HEARTBEAT        1 writes the file, 0 does not. A capture build
 *                               defaults to 0 (tools/voxel-3ds.ts): its SD
 *                               directory is the one the e2e driver reads, and
 *                               the golden path keeps exactly the writes it had
 *                               when the goldens were recorded.
 *   PV3DS_HOST_HEARTBEAT_TICKS  the tick cadence. 0 leaves only the
 *                               stage-change writes.
 */
#ifndef PV3DS_HOST_HEARTBEAT
#define PV3DS_HOST_HEARTBEAT 1
#endif
#ifndef PV3DS_HOST_HEARTBEAT_TICKS
#define PV3DS_HOST_HEARTBEAT_TICKS 30
#endif

/* A capture build already owns this directory; a playable build creates it
 * next to the two files it writes beside. */
#ifdef PV3DS_CAPTURE
#define HEARTBEAT_DIR CAPTURE_DIR
#else
#define HEARTBEAT_DIR "sdmc:/pocketvoxel-3ds"
#endif
#define HEARTBEAT_PATH HEARTBEAT_DIR "/hb.txt"

/* The divisor is never the literal 0 a zero cadence would otherwise make. */
#define HEARTBEAT_TICKS (PV3DS_HOST_HEARTBEAT_TICKS > 0 ? PV3DS_HOST_HEARTBEAT_TICKS : 1)
#define HEARTBEAT_ON_TICK(tick) \
  (PV3DS_HOST_HEARTBEAT_TICKS > 0 && ((tick) % HEARTBEAT_TICKS) == 0)

/* The steps of a frame, in the order the loop runs them. A new one needs its
 * name in STAGE_NAMES below or it reports as "?". */
typedef enum {
  STAGE_BOOT = 0,
  STAGE_PAK,
  STAGE_GUEST_BOOT,
  STAGE_APT,
  STAGE_INPUT,
  STAGE_GUEST_FRAME,
  STAGE_TICK,
  STAGE_COLLECT,
  STAGE_RECORD,
  STAGE_PREPARE,
  STAGE_FRAME_SYNC,
  STAGE_FRAME_BEGIN,
  STAGE_CLEAR,
  STAGE_DRAW,
  STAGE_FRAME_END,
  STAGE_READBACK,
  STAGE_COUNT
} HostStage;

static const char *const STAGE_NAMES[STAGE_COUNT] = {
  [STAGE_BOOT] = "boot",
  [STAGE_PAK] = "pak",
  [STAGE_GUEST_BOOT] = "guest-boot",
  [STAGE_APT] = "apt",
  [STAGE_INPUT] = "input",
  [STAGE_GUEST_FRAME] = "guest-frame",
  [STAGE_TICK] = "tick",
  [STAGE_COLLECT] = "collect",
  [STAGE_RECORD] = "record",
  [STAGE_PREPARE] = "gfx-prepare",
  [STAGE_FRAME_SYNC] = "frame-sync",
  [STAGE_FRAME_BEGIN] = "frame-begin",
  [STAGE_CLEAR] = "clear",
  [STAGE_DRAW] = "draw-walk",
  [STAGE_FRAME_END] = "frame-end",
  [STAGE_READBACK] = "readback",
};

/* External linkage and volatile on purpose: a debugger names them, and the
 * store must stay where the source puts it rather than sink past the call it
 * labels. */
volatile uint8_t voxel_host_stage = STAGE_BOOT;
volatile uint32_t voxel_host_tick = 0;

static const char *stage_name(void) {
  uint8_t index = voxel_host_stage;
  const char *name = index < STAGE_COUNT ? STAGE_NAMES[index] : NULL;
  return name == NULL ? "?" : name;
}

#if PV3DS_HOST_HEARTBEAT
static bool heartbeat_ready;      /* HEARTBEAT_DIR exists and may be written */
static bool heartbeat_all_stages; /* every stage change writes, not only the cadence */
#endif

/*
 * One line, truncate-written: the tick, the stage, and the counters the bottom
 * screen prints. Truncating rather than appending keeps the file one sector
 * whatever the run's length, and leaves the LAST line — the only one a wedge
 * is asked about — at the top of the file.
 *
 * A failed open returns silently. The heartbeat is a diagnostic and must never
 * be the thing that stops a run.
 */
static void heartbeat(void) {
#if PV3DS_HOST_HEARTBEAT
  if (!heartbeat_ready) return;
  PvVox3dsStats scene;
  pv3ds_stats(&scene);
  FILE *file = fopen(HEARTBEAT_PATH, "wb");
  if (file == NULL) return;
  fprintf(
    file,
    "tick %lu stage %s scene %lu items %lu rung %lu %s\n",
    (unsigned long)voxel_host_tick,
    stage_name(),
    (unsigned long)scene.scene_tick,
    (unsigned long)scene.draw_items,
    (unsigned long)scene.quality_tier,
    voxel_gfx_stats_line()
  );
  fclose(file);
#endif
}

/* Enter a stage. The store is the whole cost until the first frame is behind
 * us; after that every change also writes, because the wedge this exists for
 * happened inside the first 30 ticks and a tick cadence would have named
 * neither the frame nor the step. */
static void stage_enter(HostStage next) {
  voxel_host_stage = (uint8_t)next;
#if PV3DS_HOST_HEARTBEAT
  if (heartbeat_all_stages) heartbeat();
#endif
}

/*
 * Write down the memory this title was actually given.
 *
 * A .3dsx runs inside the Homebrew Launcher's allocation; a CIA is its own
 * title and the kernel gives it the region hosts/3ds/app.rsf asks for. The two
 * are not the same number, and the only way to know which one a build got is
 * to ask at run time: envIsHomebrew() says which of the two containers this
 * is, osGetApplicationMemType() names the kernel's memory layout (0-5 on an
 * Old 3DS, 6-8 on a New 3DS), and the region sizes say how much of it this
 * process may have. The bottom screen shows the same numbers, but only a
 * playable build has a bottom screen and only a person can read one.
 *
 * Two fields do not mean what their names suggest under an emulator, so both
 * are reported raw rather than reduced:
 *
 *   app_used   svcGetSystemInfo's counter for the application region. Azahar
 *              answers 124 MiB for a 96 MiB region, so osGetMemRegionFree()
 *              (size - used) underflows into a 4 GB "free". The subtraction is
 *              left to whoever reads the file.
 *   linear_free  reads 0 before the first linearAlloc, because libctru maps
 *              the linear pool on demand; it is only meaningful after the
 *              arena has been claimed.
 *
 * heap_used is newlib's own accounting (mallinfo().uordblks), which is what
 * says how large the malloc heap has to BE — the pak is 30.6 MiB of it and
 * QuickJS's parse of the pak's GAME section is most of the rest.
 */
static void report_memory(const char *stage, uint32_t arena_bytes) {
  static bool started = false;
  struct mallinfo heap = mallinfo();
#ifdef PV3DS_CAPTURE
  mkdir(CAPTURE_DIR, 0777);
#endif
  FILE *file = fopen(REPORT_PATH, started ? "ab" : "wb");
  if (file == NULL) return;
  started = true;
  fprintf(
    file,
    "%s homebrew=%d memtype=%lu heap=%lu heap_used=%lu linear=%lu linear_free=%lu "
    "app_size=%lu app_used=%lu system_size=%lu base_size=%lu arena=%lu\n",
    stage,
    envIsHomebrew() ? 1 : 0,
    (unsigned long)osGetApplicationMemType(),
    (unsigned long)envGetHeapSize(),
    (unsigned long)heap.uordblks,
    (unsigned long)envGetLinearHeapSize(),
    (unsigned long)linearSpaceFree(),
    (unsigned long)osGetMemRegionSize(MEMREGION_APPLICATION),
    (unsigned long)osGetMemRegionUsed(MEMREGION_APPLICATION),
    (unsigned long)osGetMemRegionSize(MEMREGION_SYSTEM),
    (unsigned long)osGetMemRegionSize(MEMREGION_BASE),
    (unsigned long)arena_bytes
  );
  fclose(file);
}

/* Report a boot or runtime failure as itself rather than as a timeout, then
 * park: Azahar does not stop when the app returns from main. */
static void fail(const char *message) {
  const char *text = (message == NULL || message[0] == '\0') ? "unknown failure" : message;
#ifdef PV3DS_CAPTURE
  mkdir(CAPTURE_DIR, 0777);
  FILE *file = fopen(CAPTURE_DIR "/error.txt", "wb");
#else
  FILE *file = fopen("sdmc:/pocketvoxel-3ds-error.txt", "wb");
  printf("\x1b[31mFAILED\x1b[0m\n%s\n", text);
#endif
  if (file != NULL) {
    fputs(text, file);
    fputs("\n", file);
    fclose(file);
  }
  /* Park on the vblank event rather than spinning: the thread sleeps, so
   * Rosalina and a GDB stub can still take the console. */
  for (;;) gspWaitForVBlank();
}

// ---------------------------------------------------------------------------
// the two waits a frame makes on the GPU
// ---------------------------------------------------------------------------

/*
 * C3D_FrameBegin(C3D_FRAME_SYNCDRAW) is two waits, and neither of them can end
 * on its own (citro3d source/renderqueue.c):
 *
 *   C3D_FrameSync()             blocks until BOTH screens' vblank counters
 *                               have advanced. Those counters are incremented
 *                               from libctru's GSP event thread, so this is
 *                               the 60 Hz pacing and it needs the process to
 *                               still be receiving GSP events.
 *   C3Di_WaitAndClearQueue(-1)  blocks until the GX command queue has drained,
 *                               which is the GPU finishing the previous frame.
 *                               That is what makes the arena bank the next
 *                               record rewinds safe to overwrite.
 *
 * A run whose GSP events stop sits in the first forever; a run whose GPU never
 * finishes sits in the second forever. Neither leaves a trace: the top screen
 * keeps its last frame, aptMainLoop is never reached again so HOME does
 * nothing, and nothing is written to the SD card.
 *
 * So each wait keeps its meaning and gains a deadline. The clock is
 * svcGetSystemTick, which runs at SYSCLOCK_ARM11 whatever the CPU is clocked
 * at, and which the CIA's exheader already grants (app.rsf SystemCallAccess
 * GetSystemTick). On expiry the run writes an error naming the stage, the tick
 * and the frame's counters, then parks exactly as fail() does — the failure
 * becomes a file instead of a black screen.
 *
 * PV3DS_HOST_FRAME_WAIT_MS is the deadline, four seconds by default: about 240
 * frames, two orders of magnitude past the heaviest frame the diorama draws,
 * so a merely slow frame cannot reach it. It is measured in SYSTEM ticks, not
 * wall time, so an emulator that takes wall-clock seconds over one frame does
 * not approach it either. Zero expires immediately, which is the wedge drill.
 */
#ifndef PV3DS_HOST_FRAME_WAIT_MS
#define PV3DS_HOST_FRAME_WAIT_MS 4000
#endif

#define FRAME_WAIT_TICKS \
  ((u64)PV3DS_HOST_FRAME_WAIT_MS * (u64)(SYSCLOCK_ARM11 / 1000u))

static bool wait_expired(u64 start) {
  return (svcGetSystemTick() - start) >= FRAME_WAIT_TICKS;
}

/* Sleep on the kernel timer between polls, never on a GPU event: a bounded
 * wait must not depend on the subsystem it is bounding. One millisecond
 * against a 16.7 ms vblank is ~17 polls a frame. */
static void poll_gap(void) {
  svcSleepThread(1000000ll);
}

/*
 * C3D_FrameSync's own condition — both vblank counters advanced — polled
 * against the deadline. `rounds` is how many vblank rounds to wait for.
 *
 * A suspended run stops receiving vblank events on purpose (the HOME menu,
 * sleep), so the deadline restarts while aptIsActive() is false: a suspension
 * belongs to aptMainLoop at the top of the frame loop, not to this wait.
 */
static bool vblank_settle(u32 rounds) {
  for (u32 round = 0; round < rounds; round += 1) {
    u32 top = C3D_FrameCounter(0);
    u32 bottom = C3D_FrameCounter(1);
    u64 start = svcGetSystemTick();
    while (C3D_FrameCounter(0) == top || C3D_FrameCounter(1) == bottom) {
      if (!aptIsActive()) start = svcGetSystemTick();
      else if (wait_expired(start)) return false;
      poll_gap();
    }
  }
  return true;
}

/*
 * C3D_FrameBegin's queue wait, polled: C3D_FRAME_NONBLOCK returns false while
 * the GPU still owns the previous frame. Succeeding here carries exactly the
 * guarantee the blocking form gave — the command queue has drained — so the
 * arena bank the next record rewinds is still provably free.
 */
static bool frame_begin_bounded(void) {
  u64 start = svcGetSystemTick();
  while (!C3D_FrameBegin(C3D_FRAME_NONBLOCK)) {
    if (!aptIsActive()) start = svcGetSystemTick();
    else if (wait_expired(start)) return false;
    poll_gap();
  }
  return true;
}

/* A deadline expired. Name what was being waited for, the stage, the tick and
 * the counters, in the error file and in the heartbeat, then park. */
static void wedge(const char *waiting_for) {
  PvVox3dsStats scene;
  pv3ds_stats(&scene);
  char message[288];
  snprintf(
    message,
    sizeof message,
    "%s within %lu ms: stage %s, tick %lu, scene tick %lu, items %lu, %s",
    waiting_for,
    (unsigned long)PV3DS_HOST_FRAME_WAIT_MS,
    stage_name(),
    (unsigned long)voxel_host_tick,
    (unsigned long)scene.scene_tick,
    (unsigned long)scene.draw_items,
    voxel_gfx_stats_line()
  );
  heartbeat();
  fail(message);
}

// ---------------------------------------------------------------------------
// romfs assets
// ---------------------------------------------------------------------------

/*
 * Read a whole RomFS file into one buffer.
 *
 * `alignment` matters for the pak: pak::read borrows the vertex and index
 * pools in place and the cook 16-byte-aligns them against the file's own
 * start, so a blob that does not start 16-aligned mis-aligns every pool
 * behind it. Callers of the guest source ask for a trailing NUL instead —
 * JS_Eval requires source[length] == '\0'.
 */
static uint8_t *read_romfs_file(
  const char *path,
  size_t *length,
  size_t alignment,
  bool terminate
) {
  FILE *file = fopen(path, "rb");
  if (file == NULL) return NULL;
  if (fseek(file, 0, SEEK_END) != 0) {
    fclose(file);
    return NULL;
  }
  long size = ftell(file);
  if (size < 0 || fseek(file, 0, SEEK_SET) != 0) {
    fclose(file);
    return NULL;
  }
  size_t bytes = (size_t)size + (terminate ? 1 : 0);
  uint8_t *buffer = alignment > 1 ? memalign(alignment, bytes) : malloc(bytes);
  if (buffer == NULL) {
    fclose(file);
    return NULL;
  }
  size_t read = fread(buffer, 1, (size_t)size, file);
  fclose(file);
  if (read != (size_t)size) {
    free(buffer);
    return NULL;
  }
  if (terminate) buffer[size] = '\0';
  *length = (size_t)size;
  return buffer;
}

// ---------------------------------------------------------------------------
// the linear arena
// ---------------------------------------------------------------------------

/*
 * Claim the staging arena, holding back what the expanded textures will need.
 *
 * The arena cannot grow — only the host calls linearAlloc — and the crate
 * DROPS a draw it cannot stage rather than panicking, so asking for more than
 * the linear heap can spare would trade a boot failure for a permanently holed
 * frame. Halving down to the floor keeps a smaller console running with a
 * measurable arena rather than refusing to start.
 */
static void *claim_arena(uint32_t *out_bytes) {
  uint32_t want = ARENA_WANT;
  uint32_t free_linear = linearSpaceFree();
  uint32_t reserve = MIB(PV3DS_HOST_TEXTURE_MIB);
  if (free_linear > reserve && want > free_linear - reserve) {
    want = (free_linear - reserve) & ~0xffffu;
  }
  while (want >= ARENA_FLOOR) {
    void *arena = linearAlloc(want);
    if (arena != NULL) {
      *out_bytes = want;
      return arena;
    }
    want /= 2;
  }
  return NULL;
}

// ---------------------------------------------------------------------------
// the baked tape
// ---------------------------------------------------------------------------

#ifdef PV3DS_CAPTURE

/* Read one unsigned value, decimal or 0x-prefixed hex, from [start, end). */
static bool parse_uint(const char *text, size_t start, size_t end, uint32_t *out) {
  while (start < end && (text[start] == ' ' || text[start] == '\t')) start += 1;
  if (start >= end) return false;
  bool hex = start + 1 < end && text[start] == '0' &&
             (text[start + 1] == 'x' || text[start + 1] == 'X');
  if (hex) start += 2;
  uint32_t value = 0;
  bool any = false;
  for (; start < end; start += 1) {
    char c = text[start];
    uint32_t digit;
    if (c >= '0' && c <= '9') digit = (uint32_t)(c - '0');
    else if (hex && c >= 'a' && c <= 'f') digit = (uint32_t)(c - 'a' + 10);
    else if (hex && c >= 'A' && c <= 'F') digit = (uint32_t)(c - 'A' + 10);
    else if (c == ' ' || c == '\t') break;
    else return false;
    value = value * (hex ? 16u : 10u) + digit;
    any = true;
  }
  if (!any) return false;
  *out = value;
  return true;
}

/*
 * The scripted button mask for a tick: `tick:mask,tick:mask`, where the
 * active mask is the last threshold at or before the tick.
 *
 * tools/voxel-3ds.ts extracts the entries from the story trace's
 * `t <tick> <buttons>` lines — every button transition is one entry, so the
 * threshold form replays the per-tick stream exactly. The tape travels INSIDE
 * the binary; a capture run never reads the emulator's filesystem for input.
 */
static int32_t scripted_buttons(uint32_t tick) {
  size_t length = sizeof CAPTURE_INPUT - 1;
  size_t index = 0;
  bool found = false;
  uint32_t best_tick = 0;
  uint32_t best_mask = 0;
  while (index < length) {
    while (index < length && (CAPTURE_INPUT[index] == ',' || CAPTURE_INPUT[index] == ';' ||
                              CAPTURE_INPUT[index] == ' ')) {
      index += 1;
    }
    size_t tick_start = index;
    while (index < length && CAPTURE_INPUT[index] != ':' && CAPTURE_INPUT[index] != ',') {
      index += 1;
    }
    if (index >= length || CAPTURE_INPUT[index] != ':') break;
    size_t tick_end = index;
    index += 1;
    size_t mask_start = index;
    while (index < length && CAPTURE_INPUT[index] != ',' && CAPTURE_INPUT[index] != ';') {
      index += 1;
    }
    uint32_t at = 0;
    uint32_t mask = 0;
    if (parse_uint(CAPTURE_INPUT, tick_start, tick_end, &at) &&
        parse_uint(CAPTURE_INPUT, mask_start, index, &mask) && at <= tick &&
        (!found || at >= best_tick)) {
      found = true;
      best_tick = at;
      best_mask = mask;
    }
  }
  return (int32_t)best_mask;
}

/*
 * Mark bookkeeping for a tick: its index among the marks (or -1), how many
 * marks there are, and the last mark's tick.
 *
 * Frame N of the run renders the state after tick N's ops plus Scene::tick —
 * the same state the sim hashes in tick block N — so dumping at each mark tick
 * reproduces the rasterizer's checkpoint frames.
 */
static int32_t mark_info(uint32_t tick, uint32_t *count_out, uint32_t *last_out) {
  size_t length = sizeof CAPTURE_MARKS - 1;
  size_t index = 0;
  int32_t found = -1;
  uint32_t count = 0;
  uint32_t last = 0;
  while (index < length) {
    while (index < length && (CAPTURE_MARKS[index] == ',' || CAPTURE_MARKS[index] == ' ')) {
      index += 1;
    }
    size_t start = index;
    while (index < length && CAPTURE_MARKS[index] != ',') index += 1;
    uint32_t at = 0;
    if (start < index && parse_uint(CAPTURE_MARKS, start, index, &at)) {
      if (at == tick && found < 0) found = (int32_t)count;
      if (at > last) last = at;
      count += 1;
    }
  }
  if (count_out != NULL) *count_out = count;
  if (last_out != NULL) *last_out = last;
  return found;
}

/*
 * Read the render target back.
 *
 * NOT gfxGetFramebuffer after C3D_FrameEnd: that buffer has already been
 * swapped and reads back black. An explicit display transfer untiles the
 * PICA200 colour buffer into linear CPU-readable memory.
 *
 * **The transfer's OUTPUT FORMAT MUST BE RGB8, not RGBA8.** Asking the PPF
 * for a 32-bit linear output out of this 240x400 tiled colour buffer returns
 * a picture whose rows are individually correct and progressively
 * misregistered — every fourth output row slips 64 texels — which reads as a
 * shredded diorama while the same frame presents perfectly on the screen.
 * Measured against a CPU untile of the same colour buffer: RGBA8 out matched
 * 74.6% of a known probe rectangle, RGB8 out matched 100.0%. RGB8 is also the
 * format citro3d's own presentation transfer uses, so the capture now travels
 * the path the screen travels. The alpha byte the format drops was never read:
 * the decode takes R, G and B only.
 *
 * The bytes stay in the rotated screen orientation — 240 wide by 400 tall,
 * column-major — and each capture word is byte order A, B, G, R. The driver
 * decodes with src[(x * 240 + (239 - y)) * 4] -> dst[y * 400 + x].
 */
static bool capture_write(int32_t mark) {
  /*
   * C3D_FrameEnd only queues the frame; the colour buffer is not finished
   * until the GPU is. Two bounded vblank rounds replace the C3D_FrameSync plus
   * gspWaitForVBlank this settled with — the same number of vblanks, with a
   * deadline instead of a wait that cannot end.
   *
   * What actually guarantees the GPU has finished is the transfer below:
   * C3D_SyncDisplayTransfer outside a frame drains the command queue before it
   * issues the PPF job (citro3d C3Di_SafeDisplayTransfer), so the settle above
   * is a settle and bounding it cannot change the pixels this reads.
   */
  if (!vblank_settle(2)) wedge("no vblank arrived before the readback");
  C3D_SyncDisplayTransfer(
    (u32 *)target->frameBuf.colorBuf,
    GX_BUFFER_DIM(TOP_SCREEN_H, TOP_SCREEN_W),
    (u32 *)capture_rgb,
    GX_BUFFER_DIM(TOP_SCREEN_H, TOP_SCREEN_W),
    GX_TRANSFER_FLIP_VERT(0) | GX_TRANSFER_OUT_TILED(0) | GX_TRANSFER_RAW_COPY(0) |
      GX_TRANSFER_IN_FORMAT(GX_TRANSFER_FMT_RGBA8) |
      GX_TRANSFER_OUT_FORMAT(GX_TRANSFER_FMT_RGB8) |
      GX_TRANSFER_SCALING(GX_TRANSFER_SCALE_NO)
  );
  GSPGPU_InvalidateDataCache(capture_rgb, (s32)CAPTURE_RGB_BYTES);

  /* Widen B, G, R back into the A, B, G, R word the golden format states, so
   * the on-device format change costs the driver nothing. */
  uint8_t *out = (uint8_t *)capture_buffer;
  for (size_t i = 0; i < (size_t)TOP_SCREEN_W * TOP_SCREEN_H; i += 1) {
    out[i * 4 + 0] = 0xff;
    out[i * 4 + 1] = capture_rgb[i * 3 + 0];
    out[i * 4 + 2] = capture_rgb[i * 3 + 1];
    out[i * 4 + 3] = capture_rgb[i * 3 + 2];
  }

  /* Named by MARK INDEX, which is what tests/e2e/voxel-ppsspp.ts already
   * compares against: mark k of the tape is f000k.raw on every backend. */
  char path[64];
  snprintf(path, sizeof path, CAPTURE_DIR "/f%04ld.raw", (long)mark);
  FILE *file = fopen(path, "wb");
  if (file == NULL) return false;
  size_t written = fwrite(capture_buffer, 1, CAPTURE_BYTES, file);
  return fclose(file) == 0 && written == CAPTURE_BYTES;
}

/* The sentinel the driver waits for, written only after every mark has been
 * written AND closed, so a partial file can never be compared. */
static void capture_done(void) {
  FILE *file = fopen(CAPTURE_DIR "/done", "wb");
  if (file == NULL) return;
  fputs("ok\n", file);
  fclose(file);
}

#endif /* PV3DS_CAPTURE */

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

int main(void) {
  /* Before anything is claimed: the grant itself, which is what differs
   * between a .3dsx under hbmenu and this binary installed as a CIA. */
  report_memory("entry", 0);
  gfxInitDefault();
  /* No-op on an Old 3DS; on a New 3DS it unlocks the faster clock and the
   * extra cache, which the QuickJS guest feels directly. */
  osSetSpeedupEnable(true);
#ifndef PV3DS_CAPTURE
  /* The bottom screen is the boot log and the per-frame counters. It costs
   * nothing on the top screen, which the diorama owns. */
  consoleInit(GFX_BOTTOM, NULL);
  printf("Pocket Voxel / PICA200\n");
#endif

  if (!C3D_Init(PV3DS_HOST_CMDBUF_BYTES)) fail("C3D_Init failed");
  /* Rotated, always: the top screen's framebuffer is 240 wide by 400 tall. */
  target = C3D_RenderTargetCreate(
    TOP_SCREEN_H,
    TOP_SCREEN_W,
    GPU_RB_RGBA8,
    GPU_RB_DEPTH24_STENCIL8
  );
  if (target == NULL) fail("C3D_RenderTargetCreate failed");
  C3D_RenderTargetSetOutput(target, GFX_TOP, GFX_LEFT, DISPLAY_TRANSFER_FLAGS);

  if (R_FAILED(romfsInit())) fail("romfsInit failed: the .3dsx has no romfs");

  /*
   * The boot order the crate's header pins: the arena before the pak, and the
   * pak before QuickJS. The pak is the single largest allocation of the run
   * (30.6 MiB for the shipped one) and the QuickJS heap has to fit in what is
   * left, so nothing large may be claimed after it.
   */
  uint32_t arena_bytes = 0;
  void *arena = claim_arena(&arena_bytes);
  if (arena == NULL) {
    char message[160];
    snprintf(
      message,
      sizeof message,
      "the staging arena does not fit: linear free %lu KiB, wanted %lu KiB, floor %lu KiB",
      (unsigned long)(linearSpaceFree() / 1024),
      (unsigned long)(ARENA_WANT / 1024),
      (unsigned long)(ARENA_FLOOR / 1024)
    );
    fail(message);
  }
  if (pv3ds_init(arena, arena_bytes, ARENA_BANKS) != 0) fail(pv3ds_last_error());

  stage_enter(STAGE_PAK);
  size_t pak_length = 0;
  uint8_t *pak = read_romfs_file(PAK_PATH, &pak_length, 16, false);
  if (pak == NULL) {
    char message[192];
    snprintf(
      message,
      sizeof message,
      "%s could not be read into a 16-aligned buffer "
      "(heap %lu KiB, linear free %lu KiB, app region %lu KiB)",
      PAK_PATH,
      (unsigned long)(envGetHeapSize() / 1024),
      (unsigned long)(linearSpaceFree() / 1024),
      (unsigned long)(osGetMemRegionSize(MEMREGION_APPLICATION) / 1024)
    );
    fail(message);
  }
  /* The blob is never freed: the pak's vertex, index and texel pools are
   * borrowed in place for the whole run. */
  if (pv3ds_load_pak(pak, (uint32_t)pak_length) != 0) fail(pv3ds_last_error());

  size_t guest_length = 0;
  uint8_t *guest = read_romfs_file(GUEST_PATH, &guest_length, 1, true);
  if (guest == NULL) fail(GUEST_PATH " is missing or unreadable");

  /* Everything large is now claimed — the arena, the 30.6 MiB pak, the guest
   * source — so this line is what the run has left to work in. */
  report_memory("loaded", arena_bytes);

#ifndef PV3DS_CAPTURE
  printf(
    "pak %lu KiB  arena %lu KiB x%lu\nheap %lu KiB  linear free %lu KiB\n",
    (unsigned long)(pak_length / 1024),
    (unsigned long)(arena_bytes / 1024),
    (unsigned long)ARENA_BANKS,
    (unsigned long)(envGetHeapSize() / 1024),
    (unsigned long)(linearSpaceFree() / 1024)
  );
#endif

  if (!voxel_gfx_init()) fail("the PICA200 backend failed to initialize");
  stage_enter(STAGE_GUEST_BOOT);
  if (!voxel_qjs_boot((const char *)guest, guest_length)) fail(voxel_qjs_last_error());

#if PV3DS_HOST_HEARTBEAT
  /* One directory for what a run leaves on the SD. mkdir before the first
   * write, so an hb.txt that never appears means the card itself is
   * unwritable rather than that the run never reached a frame. */
  mkdir(HEARTBEAT_DIR, 0777);
  heartbeat_ready = true;
#endif

#ifdef PV3DS_CAPTURE
  mkdir(CAPTURE_DIR, 0777);
  capture_buffer = linearAlloc(CAPTURE_BYTES);
  capture_rgb = linearAlloc(CAPTURE_RGB_BYTES);
  if (capture_buffer == NULL || capture_rgb == NULL) fail("capture buffer allocation failed");
  uint32_t mark_count = 0;
  uint32_t last_mark = 0;
  mark_info(0xffffffffu, &mark_count, &last_mark);
  if (mark_count == 0) fail("the capture build was given no marks");
#endif

  uint32_t tick = 0;
  stage_enter(STAGE_APT);
  while (aptMainLoop()) {
    voxel_host_tick = tick;
    if (HEARTBEAT_ON_TICK(tick)) heartbeat();
    stage_enter(STAGE_INPUT);
    hidScanInput();
#ifdef PV3DS_CAPTURE
    int32_t buttons = scripted_buttons(tick);
#else
    int32_t buttons = input_buttons();
#endif

    /* One guest turn per host tick: frame(buttons), exactly once. */
    stage_enter(STAGE_GUEST_FRAME);
    if (!voxel_qjs_frame(buttons)) fail(voxel_qjs_last_error());
    /*
     * Read the warp-landing flag EVERY tick, never conditionally: a stale one
     * from a cheap early map show must not license a collection later, when
     * the world is not frozen and the stall would be a visible hitch.
     */
    bool landed = pv3ds_take_map_swapped() != 0;
    /* The tick clock is the only clock in the runtime — tile animation,
     * cursors, camera tweens — so it advances at a fixed 60 Hz whatever the
     * present cadence is. */
    stage_enter(STAGE_TICK);
    pv3ds_tick();
    if (landed) {
      stage_enter(STAGE_COLLECT);
      voxel_qjs_collect();
    }

#ifdef PV3DS_CAPTURE
    /*
     * Only the marks render. The scene state is a pure function of (tick,
     * buttons) on the CPU side and draw::build is pure, so the picture at a
     * mark is identical either way — and the in-between frames would cost an
     * hour of emulator time proving nothing.
     */
    int32_t mark = mark_info(tick, NULL, NULL);
    if (mark < 0) {
      if (tick > last_mark) fail("the tape ran past its last mark without dumping it");
      tick += 1;
      stage_enter(STAGE_APT);
      continue;
    }
#endif

    stage_enter(STAGE_RECORD);
    if (pv3ds_present() != 0) fail(pv3ds_last_error());
    stage_enter(STAGE_PREPARE);
    voxel_gfx_prepare();

    /* The two halves of what C3D_FRAME_SYNCDRAW used to do in one call, each
     * with its own deadline and its own name, so a run that stops in one of
     * them says which. */
    stage_enter(STAGE_FRAME_SYNC);
    if (!vblank_settle(1)) wedge("no vblank arrived");
    stage_enter(STAGE_FRAME_BEGIN);
    if (!frame_begin_bounded()) wedge("the GPU never finished the previous frame");

    stage_enter(STAGE_CLEAR);
    /* The clear the sky pass owns. It covers the whole framebuffer, so the
     * letterbox bars carry the sky colour too. */
    C3D_RenderTargetClear(target, C3D_CLEAR_ALL, voxel_gfx_clear_word(), 0);
    C3D_FrameDrawOn(target);
    /* C3D_FrameDrawOn resets the viewport, so the letterbox comes after it. */
    uint32_t vx = 0;
    uint32_t vy = 0;
    uint32_t vw = 0;
    uint32_t vh = 0;
    voxel_gfx_viewport(&vx, &vy, &vw, &vh);
    C3D_SetViewport(vx, vy, vw, vh);
    stage_enter(STAGE_DRAW);
    voxel_gfx_render();
    stage_enter(STAGE_FRAME_END);
    C3D_FrameEnd(0);

#ifdef PV3DS_CAPTURE
    /* A frame that dropped a draw is missing geometry, which must never
     * become a golden. */
    if (voxel_gfx_dropped() > 0) fail("the frame dropped a draw during capture");
    stage_enter(STAGE_READBACK);
    if (!capture_write(mark)) fail("capture write failed");
    /* The marks are ascending, so the last tick is the last file. Testing the
     * tick rather than the index keeps this true even if a tape ever names one
     * tick twice. */
    if (tick >= last_mark) {
      /* The run's standing cost, after every texture the tape reached has been
       * expanded and the guest's state is built: the number a console has to
       * have, rather than the number libctru happened to hand out. */
      report_memory("end", arena_bytes);
      capture_done();
      /* Park: Azahar does not stop when the app returns from main, and a
       * still process is what the driver kills. Blocking on the vblank event
       * rather than spinning keeps the thread asleep, so Rosalina and a GDB
       * stub can still take a parked console. */
      for (;;) gspWaitForVBlank();
    }
#else
    if ((tick % 30) == 0) {
      PvVox3dsStats scene;
      pv3ds_stats(&scene);
      printf(
        "\x1b[6;1Htick %-6lu items %-5lu rung %lu\n%s          \n",
        (unsigned long)scene.scene_tick,
        (unsigned long)scene.draw_items,
        (unsigned long)scene.quality_tier,
        voxel_gfx_stats_line()
      );
    }
#endif
    tick += 1;
#if PV3DS_HOST_HEARTBEAT
    /* Past the first frame, every stage change writes. The wedge this was
     * built for happened inside the first 30 ticks, where the tick cadence
     * alone names neither the frame nor the step. */
    heartbeat_all_stages = true;
#endif
    stage_enter(STAGE_APT);
  }

  voxel_qjs_shutdown();
  voxel_gfx_shutdown();
  C3D_Fini();
  gfxExit();
  return 0;
}
