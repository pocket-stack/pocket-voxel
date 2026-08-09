/*
 * The PICA200 command walker.
 *
 * `crates/pocketvoxel-pica` resolves a frame into a flat command stream, a
 * deduplicated matrix table and a set of texture keys; this file executes
 * that stream with citro3d. It makes no rendering decision of its own —
 * every palette, every atlas frame, every depth behaviour, every vertex was
 * decided by the core and lowered by the crate. What lives here is the GPU
 * state each command's flags stand for, and the two things the crate
 * deliberately leaves to the host: the screen tilt and the texture objects.
 *
 * The contract is `crates/pocketvoxel-pica/include/pocketvoxel_pica.h`; the
 * parity reasoning behind each state is `docs/PICA.md`.
 *
 * Three PICA200 facts shape the code:
 *
 *   - Vertex and index data must live in linearAlloc memory. BufInfo_Init
 *     writes base_paddr = 0x18000000, the base of FCRAM, and never moves it;
 *     BufInfo_Add rejects any buffer below it and stores the rest as offsets
 *     from it, and C3D_DrawElements subtracts the same constant from the index
 *     pointer. So both pools come out of the crate's one arena, and an index
 *     pointer osConvertVirtToPhys cannot resolve makes C3D_DrawElements return
 *     before emitting — a dropped draw, not a hung one (docs/PICA.md §2.4).
 *   - There is no fragment shader. Six TEV stages stand in: stage 0 does the
 *     work and the five behind it pass the result through.
 *   - There is no paletted texture format. Every (page, frame, palette,
 *     tinted) key is its own RGBA5551 image, expanded by the crate straight
 *     into the C3D_Tex's own linear buffer.
 */

#include "voxel_gfx.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "pocketvoxel_pica.h"
#include "vshader_shbin.h"

/*
 * The top screen, and the framebuffer behind it. The render target is created
 * ROTATED — C3D_RenderTargetCreate(240, 400) — so the framebuffer's width axis
 * is the screen's vertical one. Everything the GPU is told (viewport, scissor)
 * is in framebuffer coordinates; everything the crate reports is in landscape
 * top-screen pixels.
 */
#define TOP_SCREEN_W 400u
#define TOP_SCREEN_H 240u

/* The vertex stride both formats share (pocketvoxel_pica.h §5). */
#define VERTEX_STRIDE 16

/*
 * The crate const-asserts these same numbers on the Rust side. Asserting them
 * here too is what turns a layout drift into a compile error instead of a
 * frame that reads its commands one field out of step.
 */
_Static_assert(sizeof(PvPicaCmd) == 40, "PvPicaCmd is 40 bytes");
_Static_assert(sizeof(PvPicaTexKey) == 8, "PvPicaTexKey is 8 bytes");
_Static_assert(sizeof(PvPicaTexPlan) == 16, "PvPicaTexPlan is 16 bytes");
_Static_assert(sizeof(C3D_Mtx) == 64, "C3D_Mtx is 16 floats");

/*
 * One texture slot.
 *
 * The C3D_Tex is allocated on its own rather than living inside the growable
 * array, because C3D_TexBind stores the POINTER it is given and citro3d
 * dereferences it when it next flushes state. Growing an array of C3D_Tex by
 * realloc would move a bound texture out from under that pointer; an array of
 * pointers can be grown freely.
 */
typedef struct {
  C3D_Tex *tex;
  /* A slot whose plan, allocation or C3D_TexInit failed is never retried: the
   * failure is linear memory, and asking again every frame turns one hole into
   * a stall. */
  bool failed;
} Texture;

static DVLB_s *shader_blob;
static shaderProgram_s shader_program;
static int uniform_mtx = -1;
static int uniform_uvscale = -1;

static C3D_AttrInfo attr_world;
static C3D_AttrInfo attr_flat;

/*
 * The screen tilt, the one transform the crate does not fold in. Its
 * matrices are landscape-space with the GL->PICA depth remap already applied;
 * citro3d's *Tilt matrices carry the rotation that compensates for the
 * rotated render target. Mtx_Ortho over [-1,1]^2 is the identity in x and y,
 * so Mtx_OrthoTilt over those bounds IS the tilt — with the z and w rows
 * forced back to the identity so the crate's depth mapping survives
 * (pocketvoxel_pica.h §7).
 */
static C3D_Mtx tilt;

static C3D_Mtx *matrices;
static uint32_t matrix_capacity;

static Texture *textures;
static uint32_t texture_capacity;

static uint32_t clear_word = 0x000000ffu;
static uint32_t dropped;
static uint32_t frame_draws;
static uint32_t textures_failed;
static char stats_line[192];
static char trace_line[224];
static bool initialized;

// ---------------------------------------------------------------------------
// the breadcrumb and the draw cap
// ---------------------------------------------------------------------------

/*
 * How many draw commands of each frame reach the GPU. -1 is every one of them,
 * which is what a build without --max-draws compiles.
 *
 * This exists because a frame that wedges the PICA200 wedges it on ONE command,
 * and the only evidence a halted console leaves is that the queue never
 * drained. Capping the walk turns "the GPU never finished frame 0" into a
 * bisection: 0 submits the clear and the present with no command list at all
 * (citro3d queues no GX_ProcessCommandList when the command buffer is empty),
 * so a wedge at 0 is not a draw; N and N-1 straddling the wedge names the draw.
 *
 * The cap is a build-time define rather than a runtime toggle on purpose: the
 * binary a person installs then IS the experiment, and the number it was built
 * with travels in the heartbeat next to the result.
 */
#ifndef PV3DS_HOST_MAX_DRAWS
#define PV3DS_HOST_MAX_DRAWS (-1)
#endif

/*
 * The last command the walk touched, and what the frame that reached
 * C3D_FrameEnd was made of.
 *
 * Plain stores, no formatting and no syscall, so the walk pays nothing for
 * them. `walk` is overwritten per command; `flight` is snapshotted once, at
 * the end of the walk, and is therefore still describing the SUBMITTED frame
 * while the next frame is being recorded over the crate's stats.
 */
typedef struct {
  uint32_t index;   /* command index within the frame */
  uint32_t total;   /* commands in that frame */
  uint8_t kind;     /* PV_PICA_CMD_* */
  uint8_t vfmt;     /* PV_PICA_VFMT_* */
  uint8_t depth;    /* PV_PICA_DEPTH_* */
  uint8_t flags;    /* PV_PICA_F_* */
  uint16_t page;
  uint16_t pal;
  uint32_t verts;
  uint32_t indices;
} WalkCrumb;

typedef struct {
  uint32_t frame;     /* how many frames the walk has completed */
  uint32_t submitted; /* draws this frame actually issued */
  uint32_t offered;   /* draws the frame contained */
  uint32_t verts;
  uint32_t indices;
} FlightProfile;

/* External linkage and volatile for the same reason the host's stage global
 * has both: a debugger on a halted console names them, and the store must stay
 * where the source puts it. */
volatile WalkCrumb voxel_gfx_walk;
volatile FlightProfile voxel_gfx_flight;

int32_t voxel_gfx_max_draws(void) {
  return (int32_t)(PV3DS_HOST_MAX_DRAWS);
}

// ---------------------------------------------------------------------------
// resources
// ---------------------------------------------------------------------------

static bool reserve_matrices(uint32_t count) {
  if (count <= matrix_capacity) return true;
  uint32_t want = matrix_capacity ? matrix_capacity : 32;
  while (want < count) want *= 2;
  C3D_Mtx *grown = realloc(matrices, (size_t)want * sizeof *grown);
  if (grown == NULL) return false;
  matrices = grown;
  matrix_capacity = want;
  return true;
}

static Texture *reserve_texture(uint32_t slot) {
  if (slot >= texture_capacity) {
    uint32_t want = texture_capacity ? texture_capacity : 64;
    while (want <= slot) want *= 2;
    Texture *grown = realloc(textures, (size_t)want * sizeof *grown);
    if (grown == NULL) return NULL;
    memset(grown + texture_capacity, 0, (size_t)(want - texture_capacity) * sizeof *grown);
    textures = grown;
    texture_capacity = want;
  }
  return &textures[slot];
}

/*
 * The C3D_Tex for one texture key, minting and filling it on first bind.
 *
 * The crate expands straight into `tex.data` — the texture's own linear
 * buffer — rather than into a staging copy: C3D_TexUpload is a plain memcpy
 * into exactly that pointer, so the copy would be pure cost, and the largest
 * single texture is 64 KiB.
 */
static C3D_Tex *bind_key(uint16_t page, uint16_t frame, uint16_t pal, uint8_t tinted) {
  uint8_t needs_fill = 0;
  int32_t slot = pv_pica_tex_slot(page, frame, pal, tinted, &needs_fill);
  if (slot < 0) return NULL;
  Texture *entry = reserve_texture((uint32_t)slot);
  if (entry == NULL) return NULL;
  if (entry->failed) return NULL;

  if (entry->tex == NULL) {
    PvPicaTexPlan plan;
    C3D_Tex *tex = calloc(1, sizeof *tex);
    if (tex == NULL || pv_pica_tex_plan((uint16_t)slot, &plan) != 0 ||
        !C3D_TexInit(tex, plan.width, plan.height, GPU_RGBA5551)) {
      free(tex);
      entry->failed = true;
      textures_failed += 1;
      return NULL;
    }
    /* Pixel art, and the pak cooks no mips. Linear filtering would blend the
     * content with the power-of-two padding along its edges, and a repeat
     * wrap would pull that padding in from the opposite side. */
    C3D_TexSetFilter(tex, GPU_NEAREST, GPU_NEAREST);
    C3D_TexSetWrap(tex, GPU_CLAMP_TO_EDGE, GPU_CLAMP_TO_EDGE);
    entry->tex = tex;
  }

  if (needs_fill) {
    if (pv_pica_tex_fill((uint16_t)slot, entry->tex->data, (uint32_t)entry->tex->size) != 0) {
      entry->failed = true;
      textures_failed += 1;
      C3D_TexDelete(entry->tex);
      free(entry->tex);
      entry->tex = NULL;
      return NULL;
    }
    /* The expansion was a CPU write into linear memory the GPU reads
     * directly. */
    C3D_TexFlush(entry->tex);
  }
  return entry->tex;
}

// ---------------------------------------------------------------------------
// per-command state
// ---------------------------------------------------------------------------

/*
 * The three depth behaviours the DrawList has, and only three.
 *
 * The crate's matrices carry the GL->PICA depth remap, and C3D_DepthMap(true,
 * -1, 0) lands the near plane at depth 1 and the far plane at 0. So "nearer
 * wins" is GPU_GREATER, the clear depth 0 means far, and an equal-depth
 * contest goes to whichever draw came FIRST — which is what the software
 * rasterizer's strict `z < depth` does, and why draw order is never
 * disturbed. GPU_GEQUAL would hand those contests to the last draw instead
 * and move a few hundred pixels on grass crossings and chunk borders.
 */
static void apply_depth(uint8_t depth) {
  switch (depth) {
    case PV_PICA_DEPTH_TEST_WRITE:
      C3D_DepthTest(true, GPU_GREATER, GPU_WRITE_ALL);
      return;
    case PV_PICA_DEPTH_TEST:
      C3D_DepthTest(true, GPU_GREATER, GPU_WRITE_COLOR);
      return;
    case PV_PICA_DEPTH_INVERTED:
      C3D_DepthTest(true, GPU_LESS, GPU_WRITE_COLOR);
      return;
    default:
      C3D_DepthTest(false, GPU_ALWAYS, GPU_WRITE_COLOR);
      return;
  }
}

/*
 * RGBA5551 carries one alpha bit, which expands to 0 or 255, so this test
 * rejects exactly the texels whose palette alpha was below 0x80 — the
 * rasterizer's own cutoff, evaluated at expansion time. A rejected texel
 * writes neither colour nor depth, which the pipeline gives for free as long
 * as the early depth test stays off.
 *
 * It runs on the TEXTURED passes only. The shadow decal's alpha is 102 and
 * the battle decal's is 173, so leaving the test on for the untextured passes
 * makes field shadows disappear while battle shadows stay.
 */
static void apply_alpha(uint8_t flags) {
  if (flags & PV_PICA_F_ALPHA_TEST) {
    C3D_AlphaTest(true, GPU_GREATER, 0x7f);
  } else {
    C3D_AlphaTest(false, GPU_ALWAYS, 0x00);
  }
}

/*
 * The PICA has a blender or a logic op, not both, so the OFF state of the
 * blender is a copy logic op rather than blending with identity factors.
 * Getting this wrong paints a solid black quad under every entity, because
 * the shadow decal's RGB is zero and only its alpha carries the shadow.
 */
static void apply_blend(uint8_t flags) {
  if (flags & PV_PICA_F_BLEND) {
    C3D_AlphaBlend(
      GPU_BLEND_ADD,
      GPU_BLEND_ADD,
      GPU_SRC_ALPHA,
      GPU_ONE_MINUS_SRC_ALPHA,
      GPU_SRC_ALPHA,
      GPU_ONE_MINUS_SRC_ALPHA
    );
  } else {
    C3D_ColorLogicOp(GPU_LOGICOP_COPY);
  }
}

/*
 * Stage 0 is the whole fragment pipeline.
 *
 * Textured: RGB is the texel modulated by the vertex colour (the baked face
 * shade and AO), ALPHA is the texel ALONE. Taking alpha from the texture
 * rather than modulating it is deliberate — it makes the alpha test the TEXEL
 * test the rasterizer performs, whatever a vertex's baked AO alpha happens to
 * be.
 *
 * Untextured: both channels replace from the vertex colour.
 */
static void apply_tev(bool textured) {
  C3D_TexEnv *env = C3D_GetTexEnv(0);
  C3D_TexEnvInit(env);
  if (textured) {
    C3D_TexEnvSrc(env, C3D_RGB, GPU_TEXTURE0, GPU_PRIMARY_COLOR, 0);
    C3D_TexEnvFunc(env, C3D_RGB, GPU_MODULATE);
    C3D_TexEnvSrc(env, C3D_Alpha, GPU_TEXTURE0, 0, 0);
    C3D_TexEnvFunc(env, C3D_Alpha, GPU_REPLACE);
  } else {
    C3D_TexEnvSrc(env, C3D_Both, GPU_PRIMARY_COLOR, 0, 0);
    C3D_TexEnvFunc(env, C3D_Both, GPU_REPLACE);
  }
}

// ---------------------------------------------------------------------------
// the frame
// ---------------------------------------------------------------------------

void voxel_gfx_prepare(void) {
  if (!initialized) return;
  const PvPicaFrame *f = pv_pica_frame();
  dropped = 0;
  frame_draws = 0;
  clear_word = 0x000000ffu;

  /* The tilt over the (small, deduplicated) matrix table. C3D_Mtx.m[] is
   * row-major with each row's components reversed and the crate already emits
   * that order, so the memcpy is right where a transpose would not be. */
  if (reserve_matrices(f->matrix_count)) {
    for (uint32_t i = 0; i < f->matrix_count; i += 1) {
      C3D_Mtx source;
      memcpy(source.m, f->matrices + (size_t)i * 16, sizeof source.m);
      Mtx_Multiply(&matrices[i], &tilt, &source);
    }
  } else {
    /* No matrices, no draws: the walk skips every command whose matrix index
     * is out of range rather than transforming through garbage. */
    matrix_capacity = 0;
  }

  /*
   * The clear the sky pass owns, and the arena extent the CPU just wrote.
   *
   * A PICA RGBA8 target stores bytes A, B, G, R and the word reads back
   * R<<24 | G<<16 | B<<8 | A; the DrawList colour is A<<24 | B<<16 | G<<8 | R.
   * Those are byte reversals of each other, so passing the colour straight
   * through would clear the horizon's light blue as a warm cream.
   */
  uint32_t low = 0xffffffffu;
  uint32_t high = 0;
  for (uint32_t i = 0; i < f->cmd_count; i += 1) {
    const PvPicaCmd *c = &f->cmds[i];
    if (c->kind == PV_PICA_CMD_CLEAR) {
      clear_word = __builtin_bswap32(c->clear_abgr);
      continue;
    }
    /* Counted here rather than in the walk because the walk STOPS at the draw
     * cap, and the number a bisect needs is how many draws the frame has, not
     * how many it got through. */
    if (c->index_count != 0 && c->vert_count != 0) frame_draws += 1;
    uint32_t vertex_end = c->vert_offset + c->vert_count * VERTEX_STRIDE;
    uint32_t index_end = c->index_offset + c->index_count * 2u;
    if (c->vert_offset < low) low = c->vert_offset;
    if (vertex_end > high) high = vertex_end;
    if (index_end > high) high = index_end;
  }
  /* The arena is ordinary cached linear memory and the PICA reads main memory
   * directly, so this frame's staged bytes have to be written back before any
   * command can reference them. Skipping it draws a previous frame's contents
   * intermittently, most visibly on the pulled geometry. */
  if (high > low) GSPGPU_FlushDataCache(f->arena + low, high - low);
}

uint32_t voxel_gfx_clear_word(void) {
  return clear_word;
}

/*
 * The letterboxed viewport, converted from the crate's landscape rectangle
 * into the rotated framebuffer's own coordinates.
 *
 * The framebuffer is 240 wide by 400 tall and its axes run: framebuffer ROW =
 * landscape x, framebuffer COLUMN = 239 - landscape y (that is the same
 * mapping the capture readback decodes with). C3D_SetViewport's first pair is
 * along the 240 axis, so the landscape band [y, y+h) becomes the column band
 * [240 - (y+h), 240 - y). The letterbox is centred, which makes those two
 * numbers equal here — the mirrored form is written out anyway so an
 * off-centre rectangle could not silently land on the wrong side.
 */
void voxel_gfx_viewport(uint32_t *x, uint32_t *y, uint32_t *w, uint32_t *h) {
  int32_t lx = 0;
  int32_t ly = 0;
  int32_t lw = (int32_t)TOP_SCREEN_W;
  int32_t lh = (int32_t)TOP_SCREEN_H;
  pv_pica_viewport(&lx, &ly, &lw, &lh);
  *x = (uint32_t)((int32_t)TOP_SCREEN_H - (ly + lh));
  *y = (uint32_t)lx;
  *w = (uint32_t)lh;
  *h = (uint32_t)lw;
}

void voxel_gfx_render(void) {
  if (!initialized) return;
  const PvPicaFrame *f = pv_pica_frame();

  C3D_BindProgram(&shader_program);

  /*
   * Frame-constant state.
   *
   * Back-face culling is FORBIDDEN, not merely unset: the cooked streams do
   * not share one winding, so any single cull mode eats faces that should
   * stay — and C3D_Init's own default is GPU_CULL_BACK_CCW, so this is a call
   * the host must make rather than a default it inherits.
   *
   * Early depth test must stay off: it would move the depth write ahead of
   * the alpha kill, and every alpha-tested sprite would leave an invisible
   * rectangular occluder the shape of its bounding box.
   */
  C3D_CullFace(GPU_CULL_NONE);
  C3D_DepthMap(true, -1.0f, 0.0f);
  C3D_EarlyDepthTest(false, GPU_EARLYDEPTH_GREATER, 0);
  /* The five stages behind stage 0 pass the result through untouched. */
  for (int stage = 1; stage < 6; stage += 1) C3D_TexEnvInit(C3D_GetTexEnv(stage));

  int last_depth = -1;
  int last_alpha = -1;
  int last_blend = -1;
  int last_tev = -1;
  int last_vfmt = -1;
  C3D_Tex *bound = NULL;
  const int32_t cap = voxel_gfx_max_draws();
  uint32_t submitted = 0;
  uint32_t flight_verts = 0;
  uint32_t flight_indices = 0;

  for (uint32_t i = 0; i < f->cmd_count; i += 1) {
    const PvPicaCmd *c = &f->cmds[i];
    /* The breadcrumb is written BEFORE the command runs, so a stop inside the
     * walk — a texture expansion, a bind, a buffer configuration — leaves the
     * command that was running named rather than the one before it. */
    voxel_gfx_walk.index = i;
    voxel_gfx_walk.total = f->cmd_count;
    voxel_gfx_walk.kind = c->kind;
    voxel_gfx_walk.vfmt = c->vfmt;
    voxel_gfx_walk.depth = c->depth;
    voxel_gfx_walk.flags = c->flags;
    voxel_gfx_walk.page = c->page;
    voxel_gfx_walk.pal = c->pal;
    voxel_gfx_walk.verts = c->vert_count;
    voxel_gfx_walk.indices = c->index_count;
    /* The clear was applied before the frame opened (voxel_gfx_prepare). */
    if (c->kind != PV_PICA_CMD_DRAW) continue;
    if (c->index_count == 0 || c->vert_count == 0) continue;
    /* The cap stops the walk rather than skipping past it: "the first N draws
     * of the frame" is the experiment, and a hole in the middle would be a
     * different picture with the same draw count. */
    if (cap >= 0 && submitted >= (uint32_t)cap) break;
    if (c->mtx >= f->matrix_count || c->mtx >= matrix_capacity) {
      dropped += 1;
      continue;
    }

    bool textured = (c->flags & PV_PICA_F_TEXTURED) != 0;
    if (textured) {
      C3D_Tex *tex = bind_key(c->page, c->frame, c->pal, (c->flags & PV_PICA_F_TINTED) != 0);
      if (tex == NULL) {
        dropped += 1;
        continue;
      }
      if (tex != bound) {
        C3D_TexBind(0, tex);
        bound = tex;
      }
    }

    if (c->depth != last_depth) {
      apply_depth(c->depth);
      last_depth = c->depth;
    }
    int alpha = (c->flags & PV_PICA_F_ALPHA_TEST) != 0;
    if (alpha != last_alpha) {
      apply_alpha(c->flags);
      last_alpha = alpha;
    }
    int blend = (c->flags & PV_PICA_F_BLEND) != 0;
    if (blend != last_blend) {
      apply_blend(c->flags);
      last_blend = blend;
    }
    if ((int)textured != last_tev) {
      apply_tev(textured);
      last_tev = (int)textured;
    }

    if ((int)c->vfmt != last_vfmt) {
      C3D_SetAttrInfo(c->vfmt == PV_PICA_VFMT_WORLD ? &attr_world : &attr_flat);
      /* Attribute 1 is FIXED in the untextured configuration — the flat vertex
       * carries no texcoord. Give it a defined value rather than whatever the
       * last textured draw left in the register. */
      if (c->vfmt != PV_PICA_VFMT_WORLD) C3D_FixedAttribSet(1, 0.0f, 0.0f, 0.0f, 1.0f);
      last_vfmt = (int)c->vfmt;
    }

    /*
     * The buffer base is this command's own vertex block, so its u16 indices
     * all start at 0 — the pak's vert_base convention, preserved. The index
     * pointer is addressed independently, from the base of FCRAM, so where it
     * sits relative to this block does not matter; what matters is that it is
     * linear memory, which the arena guarantees.
     */
    C3D_BufInfo buffer;
    BufInfo_Init(&buffer);
    int attributes = c->vfmt == PV_PICA_VFMT_WORLD ? 3 : 2;
    u64 permutation = c->vfmt == PV_PICA_VFMT_WORLD ? 0x021 : 0x20;
    if (BufInfo_Add(&buffer, f->arena + c->vert_offset, VERTEX_STRIDE, attributes, permutation) < 0) {
      dropped += 1;
      continue;
    }
    C3D_SetBufInfo(&buffer);

    C3D_FVUnifMtx4x4(GPU_VERTEX_SHADER, uniform_mtx, &matrices[c->mtx]);
    C3D_FVUnifSet(GPU_VERTEX_SHADER, uniform_uvscale, c->uv_scale[0], c->uv_scale[1], 0.0f, 0.0f);
    C3D_DrawElements(
      GPU_TRIANGLES,
      (int)c->index_count,
      C3D_UNSIGNED_SHORT,
      f->arena + c->index_offset
    );
    submitted += 1;
    flight_verts += c->vert_count;
    flight_indices += c->index_count;
  }

  /*
   * What was handed to the GPU, snapshotted here and not read again until the
   * next frame's queue wait — which is exactly the window in which this frame
   * is the one in flight. The crate's own counters are overwritten by the next
   * record, which happens BEFORE that wait.
   */
  voxel_gfx_flight.submitted = submitted;
  voxel_gfx_flight.offered = frame_draws;
  voxel_gfx_flight.verts = flight_verts;
  voxel_gfx_flight.indices = flight_indices;
  voxel_gfx_flight.frame += 1;
}

uint32_t voxel_gfx_dropped(void) {
  PvPicaStats stats;
  pv_pica_stats(&stats);
  return dropped + stats.dropped_arena + stats.dropped_texture;
}

const char *voxel_gfx_stats_line(void) {
  PvPicaStats stats;
  pv_pica_stats(&stats);
  uint32_t count = 0;
  uint32_t bytes = 0;
  pv_pica_tex_cost(&count, &bytes);
  snprintf(
    stats_line,
    sizeof stats_line,
    "draws %lu verts %lu idx %lu tex %lu/%lu KiB arena %lu/%lu KiB drop a%lu t%lu w%lu",
    (unsigned long)stats.draws,
    (unsigned long)stats.verts,
    (unsigned long)stats.indices,
    (unsigned long)count,
    (unsigned long)(bytes / 1024),
    (unsigned long)(stats.arena_used / 1024),
    (unsigned long)(stats.arena_high_water / 1024),
    (unsigned long)stats.dropped_arena,
    (unsigned long)stats.dropped_texture,
    (unsigned long)textures_failed
  );
  return stats_line;
}

/*
 * The frame the GPU is on, and the command the CPU last touched.
 *
 * `gpu` is the SUBMITTED frame: its index, how many of its draws were issued
 * against how many it had, and their vertex and index totals. `cap` is the
 * compiled-in draw cap or `-` for none.
 *
 * `walk` is the last command the walk REACHED, which is one of three things
 * and the stage says which:
 *
 *   stage draw-walk        the command the walk stopped inside — a texture
 *                          expansion, a bind, a buffer configuration.
 *   stage anything else,   the last command of the frame: the walk finished.
 *   no cap
 *   a cap                  the first command the cap REFUSED, which is the
 *                          next draw to admit when the bisect steps up.
 */
const char *voxel_gfx_trace_line(void) {
  int32_t cap = voxel_gfx_max_draws();
  char cap_text[12];
  if (cap < 0) {
    cap_text[0] = '-';
    cap_text[1] = '\0';
  } else {
    snprintf(cap_text, sizeof cap_text, "%ld", (long)cap);
  }
  snprintf(
    trace_line,
    sizeof trace_line,
    "gpu f%lu draws %lu/%lu verts %lu idx %lu cap %s "
    "walk cmd %lu/%lu kind %u vfmt %u depth %u flags 0x%x page %u pal %u v %lu i %lu",
    (unsigned long)voxel_gfx_flight.frame,
    (unsigned long)voxel_gfx_flight.submitted,
    (unsigned long)voxel_gfx_flight.offered,
    (unsigned long)voxel_gfx_flight.verts,
    (unsigned long)voxel_gfx_flight.indices,
    cap_text,
    (unsigned long)voxel_gfx_walk.index,
    (unsigned long)voxel_gfx_walk.total,
    (unsigned)voxel_gfx_walk.kind,
    (unsigned)voxel_gfx_walk.vfmt,
    (unsigned)voxel_gfx_walk.depth,
    (unsigned)voxel_gfx_walk.flags,
    (unsigned)voxel_gfx_walk.page,
    (unsigned)voxel_gfx_walk.pal,
    (unsigned long)voxel_gfx_walk.verts,
    (unsigned long)voxel_gfx_walk.indices
  );
  return trace_line;
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

bool voxel_gfx_init(void) {
  shader_blob = DVLB_ParseFile((u32 *)vshader_shbin, vshader_shbin_size);
  if (shader_blob == NULL) return false;
  shaderProgramInit(&shader_program);
  shaderProgramSetVsh(&shader_program, &shader_blob->DVLE[0]);
  C3D_BindProgram(&shader_program);
  uniform_mtx = shaderInstanceGetUniformLocation(shader_program.vertexShader, "mtx");
  uniform_uvscale = shaderInstanceGetUniformLocation(shader_program.vertexShader, "uvscale");
  if (uniform_mtx < 0 || uniform_uvscale < 0) return false;

  Mtx_OrthoTilt(&tilt, -1.0f, 1.0f, -1.0f, 1.0f, 0.0f, 1.0f, true);
  tilt.r[2].x = 0.0f;
  tilt.r[2].y = 0.0f;
  tilt.r[2].z = 1.0f;
  tilt.r[2].w = 0.0f;
  tilt.r[3].x = 0.0f;
  tilt.r[3].y = 0.0f;
  tilt.r[3].z = 0.0f;
  tilt.r[3].w = 1.0f;

  /*
   * The two vertex layouts, both 16 bytes.
   *
   * The world vertex is the pak's own: [u16 u, u16 v][u32 abgr][i16 x, y, z,
   * pad]. The buffer's component order is therefore texcoord, colour,
   * position while the shader's registers are position, texcoord, colour —
   * which is what the 0x021 permutation says.
   *
   * s16 attributes convert as RAW INTEGERS on this GPU. There is no implicit
   * division by 32768 like the GE's TRANSFORM_3D, which is why positions
   * arrive in world pixels with no counter-scale in the matrix and why
   * texcoords need the shader's uv_scale.
   */
  AttrInfo_Init(&attr_world);
  AttrInfo_AddLoader(&attr_world, 0, GPU_SHORT, 3);
  AttrInfo_AddLoader(&attr_world, 1, GPU_SHORT, 2);
  AttrInfo_AddLoader(&attr_world, 2, GPU_UNSIGNED_BYTE, 4);

  AttrInfo_Init(&attr_flat);
  AttrInfo_AddLoader(&attr_flat, 0, GPU_FLOAT, 3);
  AttrInfo_AddFixed(&attr_flat, 1);
  AttrInfo_AddLoader(&attr_flat, 2, GPU_UNSIGNED_BYTE, 4);

  initialized = true;
  return true;
}

void voxel_gfx_shutdown(void) {
  if (!initialized) return;
  for (uint32_t slot = 0; slot < texture_capacity; slot += 1) {
    if (textures[slot].tex != NULL) {
      C3D_TexDelete(textures[slot].tex);
      free(textures[slot].tex);
    }
  }
  free(textures);
  textures = NULL;
  texture_capacity = 0;
  free(matrices);
  matrices = NULL;
  matrix_capacity = 0;
  shaderProgramFree(&shader_program);
  DVLB_Free(shader_blob);
  shader_blob = NULL;
  initialized = false;
}
