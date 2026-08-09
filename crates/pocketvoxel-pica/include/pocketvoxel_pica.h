/*
 * pocketvoxel_pica.h — the C side of the Pocket Voxel PICA200 backend.
 *
 * The split, and why it is this way round: citro3d is a C library that is
 * largely `static inline`, so unlike the PSP (where `pocketvoxel-gu` calls
 * sceGu from Rust) the 3DS puts the GPU calls in C. **Rust resolves the
 * frame, C issues the citro3d calls.**
 *
 *   Rust owns  the pak, the DrawList, the frame lowering, the texel layout.
 *   C owns     citro3d, linearAlloc, the C3D_Tex array, the frame lifecycle,
 *              present.
 *
 * Recording is driven from the host's own Rust glue, which owns the QuickJS
 * guest and the retained Scene:
 *
 *     pocketvoxel_pica::global().record(&draw::build(&scene, pak), pak)
 *
 * The C side then reads what it recorded through pv_pica_frame() and walks
 * the commands in order. Nothing here draws, allocates linear memory, or
 * decides when a frame begins.
 *
 * Every struct below is mirrored by a #[repr(C)] type in the crate, and the
 * crate const-asserts the sizes.
 */
#ifndef POCKETVOXEL_PICA_H
#define POCKETVOXEL_PICA_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ==========================================================================
 * Command stream
 * ========================================================================== */

/* PvPicaCmd.kind */
#define PV_PICA_CMD_CLEAR 0 /* the frame clear; `Item::SkyBands` owns it */
#define PV_PICA_CMD_DRAW  1 /* an indexed triangle list */

/* PvPicaCmd.vfmt — see the attribute setup below. Both are 16 bytes. */
#define PV_PICA_VFMT_WORLD 0 /* textured:   i16 uv | u8 rgba | i16 xyz */
#define PV_PICA_VFMT_FLAT  1 /* untextured: f32 xyz | u8 rgba       */

/*
 * PvPicaCmd.depth — the DrawList has exactly three depth behaviours and this
 * is all three. With the depth map below, "nearer wins" is GPU_GREATER.
 */
#define PV_PICA_DEPTH_NONE       0 /* no test, no write (sky bands, GB UI) */
#define PV_PICA_DEPTH_TEST_WRITE 1 /* meshes and cards */
#define PV_PICA_DEPTH_TEST       2 /* ShadowDecal: tests, never writes */
#define PV_PICA_DEPTH_INVERTED   3 /* Ghost: draws only where occluded */

/* PvPicaCmd.flags */
#define PV_PICA_F_TEXTURED   1 /* bind (page, frame, pal, tinted) */
#define PV_PICA_F_ALPHA_TEST 2 /* GPU_GREATER against 0x7f */
#define PV_PICA_F_BLEND      4 /* src_alpha, 1 - src_alpha */
#define PV_PICA_F_TINTED     8 /* the palette carries the day tint */

/*
 * One recorded draw. 40 bytes.
 *
 * `vert_offset` and `index_offset` are BYTE offsets from PvPicaFrame.arena.
 * The indices are uint16_t and relative to this command's OWN vertex block,
 * so the C side binds `arena + vert_offset` as the buffer base and every
 * index starts at 0 — the pak's own vert_base convention, preserved.
 */
typedef struct {
  uint8_t kind;  /* PV_PICA_CMD_*  */
  uint8_t vfmt;  /* PV_PICA_VFMT_* */
  uint8_t depth; /* PV_PICA_DEPTH_*/
  uint8_t flags; /* PV_PICA_F_*    */

  /* The texture cache key, with `flags & PV_PICA_F_TINTED`. `pal` is the
   * VPAL index the CORE resolved (draw::resolve_pal) — never re-derive it.
   * One page draws through several palettes in one frame. */
  uint16_t page;
  uint16_t frame;
  uint16_t pal;
  /* Index into PvPicaFrame.matrices. */
  uint16_t mtx;

  uint32_t vert_offset;
  uint32_t vert_count;
  uint32_t index_offset;
  uint32_t index_count;
  /* PV_PICA_CMD_CLEAR only: ABGR, already day-tinted by the core. */
  uint32_t clear_abgr;

  /* Multiply the raw int16 texcoord by this to get the PICA's normalized
   * coordinate. Folds the pak's fixed point and the POT envelope into one
   * shader multiply — the PICA has no `sceGuTexScale`. */
  float uv_scale[2];
} PvPicaCmd;

/* The four facts that identify one expanded texture. 8 bytes. */
typedef struct {
  uint16_t page;
  uint16_t frame; /* already reduced modulo the page's frame count */
  uint16_t pal;   /* the VPAL index draw::resolve_pal returned */
  uint8_t tinted; /* 0 only for the GB UI layer */
  uint8_t _pad;
} PvPicaTexKey;

/* One texture's envelope. 16 bytes. */
typedef struct {
  uint16_t src_w; /* the cooked page's real size */
  uint16_t src_h;
  uint16_t width; /* the POT envelope to pass to C3D_TexInit */
  uint16_t height;
  float u_scale; /* src_w / width — already folded into PvPicaCmd.uv_scale */
  float v_scale;
} PvPicaTexPlan;

/* Last frame's counters, including the graceful-degradation ones. */
typedef struct {
  uint32_t commands;
  uint32_t draws;
  uint32_t verts;
  uint32_t indices;
  uint32_t textures; /* distinct textures this frame binds */
  uint32_t arena_used;
  uint32_t arena_high_water;
  uint32_t dropped_arena;   /* draws the arena could not hold */
  uint32_t dropped_texture; /* draws naming a page/palette the pak lacks */
  uint32_t pull_verts;
  uint32_t uv_clamped;
} PvPicaStats;

/*
 * The recorded frame. Valid until the next record(), which is also when the
 * arena bank these offsets index is rewound.
 */
typedef struct {
  const PvPicaCmd *cmds;
  uint32_t cmd_count;
  /* matrix_count * 16 floats, each already in C3D_Mtx.m[] order. */
  const float *matrices;
  uint32_t matrix_count;
  /* This frame's distinct textures — what the expansion set costs. */
  const PvPicaTexKey *keys;
  uint32_t key_count;
  uint8_t *arena;
} PvPicaFrame;

/* ==========================================================================
 * Entry points
 * ========================================================================== */

/*
 * Parse the pak and adopt the linear arena. `pak_blob` must stay alive and
 * 16-byte aligned for the whole run (the host leaks it, the PSP pattern).
 * `arena` MUST be linearAlloc memory: BufInfo_Add rejects any pointer below
 * physical 0x18000000, so malloc memory can never be a VBO.
 *
 * `banks` splits the arena; the crate rewinds one bank per frame, so with
 * banks >= 2 and a host loop whose C3D_FrameBegin waits for the GPU command
 * queue to drain, the bank being rewound is two frames old and the GPU is
 * provably done with it. That wait is what matters, not which flag spells it:
 * hosts/3ds polls C3D_FRAME_NONBLOCK against a deadline so a GPU that never
 * finishes reports itself instead of hanging. Two banks of 6 MiB is what the
 * backend was budgeted against.
 *
 * Returns 0, or -1 with pv_pica_last_error() set.
 */
int32_t pv_pica_init(const void *pak_blob, uint32_t pak_len, void *arena,
                     uint32_t arena_bytes, uint32_t banks);

/* NUL-terminated and static; empty when there is no error. */
const char *pv_pica_last_error(void);

/* The frame most recently recorded. Never NULL. */
const PvPicaFrame *pv_pica_frame(void);

void pv_pica_stats(PvPicaStats *out);

/*
 * The letterboxed viewport, in landscape top-screen pixels: 400x226 at y=7.
 *
 * The pak is hard-rejected unless META says 480x272, and VIEW_W/VIEW_H also
 * fix the camera aspect, the UI scale and the sky horizon row — so the
 * diorama is not re-cooked for this screen. It renders through the existing
 * 480x272 camera into the widest rectangle that keeps that aspect, costing
 * 7 px of bar top and bottom. Apply with C3D_SetViewport AFTER
 * C3D_FrameDrawOn, which resets it.
 */
void pv_pica_viewport(int32_t *x, int32_t *y, int32_t *w, int32_t *h);

/* ==========================================================================
 * Textures
 * ==========================================================================
 *
 * The PICA200 has no paletted texture format, so every (page, frame, pal,
 * tinted) key becomes its own RGBA5551 image. Slot ids are stable for the
 * life of the process, so a flat C3D_Tex array indexed by slot is the
 * intended host structure. Measured over the shipped pak: 541 distinct
 * textures, 12.70 MiB.
 */

/*
 * The slot for one key, minting it on first bind. Writes 1 to `needs_fill`
 * when the host still owes this slot a pv_pica_tex_fill — on a fresh slot,
 * and again whenever the day tint moved, because the tint lives inside the
 * expanded texels. Returns the slot id, or -1.
 */
int32_t pv_pica_tex_slot(uint16_t page, uint16_t frame, uint16_t pal,
                         uint8_t tinted, uint8_t *needs_fill);

/* The envelope a slot uploads. Returns 0 or -1. */
int32_t pv_pica_tex_plan(uint16_t slot, PvPicaTexPlan *out);

/*
 * Expand slot `slot` into `out` (the C3D_Tex's own buffer), which must be at
 * least plan.width * plan.height * 2 bytes. Clears the slot's fill debt.
 * Returns 0 or -1.
 */
int32_t pv_pica_tex_fill(uint16_t slot, void *out, uint32_t out_bytes);

/* Textures minted so far and the linear memory they occupy. */
void pv_pica_tex_cost(uint32_t *textures, uint32_t *bytes);

/* ==========================================================================
 * What the C side must set up
 * ==========================================================================
 *
 * 1. FRAME-CONSTANT STATE
 *
 *      C3D_CullFace(GPU_CULL_NONE);
 *
 *    Back-face culling is FORBIDDEN, not merely unset: the cooked streams do
 *    not share one winding (column tops, gables, water and grass slabs are
 *    each emitted in their own order), so any single cull mode eats faces
 *    that should stay. The honest fix is geometric, at cook time.
 *
 *      C3D_DepthMap(true, -1.0f, 0.0f);
 *
 *    The matrices already carry the GL -> PICA depth remap (GL clip z in
 *    [-w, w] becomes [-w, 0]), so with this depth map the near plane lands at
 *    depth 1 and the far plane at 0. "Nearer wins" is therefore GPU_GREATER —
 *    C3D_Init's own default — the clear depth is 0, and an equal-depth
 *    contest goes to whichever draw came FIRST, which is what the software
 *    rasterizer's strict `z < depth` does and why draw order must never be
 *    disturbed.
 *
 * 2. PER-COMMAND STATE
 *
 *      depth NONE        C3D_DepthTest(false, GPU_ALWAYS, GPU_WRITE_COLOR)
 *      depth TEST_WRITE  C3D_DepthTest(true, GPU_GREATER, GPU_WRITE_ALL)
 *      depth TEST        C3D_DepthTest(true, GPU_GREATER, GPU_WRITE_COLOR)
 *      depth INVERTED    C3D_DepthTest(true, GPU_LESS,    GPU_WRITE_COLOR)
 *
 *      F_ALPHA_TEST      C3D_AlphaTest(true, GPU_GREATER, 0x7f)
 *      F_BLEND           C3D_AlphaBlend(GPU_BLEND_ADD, GPU_BLEND_ADD,
 *                          GPU_SRC_ALPHA, GPU_ONE_MINUS_SRC_ALPHA,
 *                          GPU_SRC_ALPHA, GPU_ONE_MINUS_SRC_ALPHA)
 *
 *    RGBA5551 carries one alpha bit, which expands to 0 or 255, so the alpha
 *    test at 0x7f discards exactly the texels whose palette alpha was < 0x80
 *    — the software rasterizer's own cutoff. A discarded texel writes neither
 *    colour nor depth, which the depth test gives for free.
 *
 * 3. TEV
 *
 *      textured:    RGB = texture0 * primary colour, ALPHA = texture0
 *      untextured:  RGB and ALPHA = primary colour
 *
 *    Taking ALPHA from the texture alone (not modulated by the vertex colour)
 *    is deliberate: it makes the alpha test the TEXEL test the rasterizer
 *    performs, whatever a vertex's baked AO alpha happens to be.
 *
 * 4. SAMPLER
 *
 *      C3D_TexSetFilter(&tex, GPU_NEAREST, GPU_NEAREST);
 *      C3D_TexSetWrap(&tex, GPU_CLAMP_TO_EDGE, GPU_CLAMP_TO_EDGE);
 *
 *    Pixel art, and the pak cooks no mips. Linear filtering would blend
 *    content with the POT padding along the content's edges; a repeat wrap
 *    would pull that padding in from the opposite side.
 *
 * 5. ATTRIBUTES — two configurations, switched when PvPicaCmd.vfmt changes.
 *    Both vertices are 16 bytes.
 *
 *      AttrInfo_Init(&world);
 *      AttrInfo_AddLoader(&world, 0, GPU_SHORT, 3);         // v0 position
 *      AttrInfo_AddLoader(&world, 1, GPU_SHORT, 2);         // v1 texcoord
 *      AttrInfo_AddLoader(&world, 2, GPU_UNSIGNED_BYTE, 4); // v2 colour
 *      // buffer order is [texcoord][colour][position] -> permutation 0x021
 *
 *      AttrInfo_Init(&flat);
 *      AttrInfo_AddLoader(&flat, 0, GPU_FLOAT, 3);          // v0 position
 *      AttrInfo_AddFixed(&flat, 1);                         // v1 unused
 *      AttrInfo_AddLoader(&flat, 2, GPU_UNSIGNED_BYTE, 4);  // v2 colour
 *      // buffer order is [position][colour] -> permutation 0x20
 *
 *    s16 attributes convert to float as RAW INTEGERS — there is no implicit
 *    division by 32768 like the PSP GE's TRANSFORM_3D. That is why positions
 *    arrive in world pixels with no counter-scale in the model matrix, and
 *    why texcoords need PvPicaCmd.uv_scale.
 *
 * 6. THE VERTEX SHADER
 *
 *      gl_Position   = mtx * vec4(position, 1.0)
 *      out texcoord  = texcoord * uv_scale
 *      out colour    = colour
 *
 *    `mtx` is one uniform, uploaded per command from PvPicaFrame.matrices;
 *    `uv_scale` is a second. Remember picasso freezes the PICA200 on two
 *    consecutive `mova`, and only one input register may be referenced across
 *    one instruction's source operands.
 *
 * 7. THE SCREEN TILT — the one thing this crate deliberately does NOT fold in
 *
 *    The matrices are LANDSCAPE-space with the PICA depth mapping already
 *    applied. The 3DS render target is created rotated
 *    (C3D_RenderTargetCreate(240, 400, ...)), and citro3d's *Tilt matrices
 *    carry the rotation that compensates. This crate cannot build that
 *    rotation without guessing its sign, so the C side pre-multiplies it once
 *    per frame over the (small, deduplicated) matrix table:
 *
 *      C3D_Mtx tilt;
 *      Mtx_OrthoTilt(&tilt, -1.0f, 1.0f, -1.0f, 1.0f, 0.0f, 1.0f, true);
 *      // Mtx_Ortho over [-1,1]^2 is the identity in x and y, so OrthoTilt
 *      // over those bounds IS the tilt. Force the z and w rows back to the
 *      // identity so the depth mapping this crate applied survives.
 *      tilt.r[2].x = 0; tilt.r[2].y = 0; tilt.r[2].z = 1; tilt.r[2].w = 0;
 *      tilt.r[3].x = 0; tilt.r[3].y = 0; tilt.r[3].z = 0; tilt.r[3].w = 1;
 *
 *      for (uint32_t i = 0; i < f->matrix_count; i++) {
 *        C3D_Mtx m;
 *        memcpy(m.m, f->matrices + i * 16, sizeof m.m);
 *        Mtx_Multiply(&uploaded[i], &tilt, &m);
 *      }
 *
 *    C3D_Mtx is row-major and each row is a C3D_FVec, which citro3d declares
 *    as `struct { float w, z, y, x; }` — so C3D_Mtx.m[] is row-major with the
 *    components of each row REVERSED. The matrices here are already in that
 *    order, which is why the memcpy above is correct and a transpose would
 *    not be.
 *
 * ==========================================================================
 * The draw loop
 * ==========================================================================
 *
 *   const PvPicaFrame *f = pv_pica_frame();
 *   for (uint32_t i = 0; i < f->cmd_count; i++) {
 *     const PvPicaCmd *c = &f->cmds[i];
 *     if (c->kind == PV_PICA_CMD_CLEAR) {
 *       // ABGR -> the RGBA8 word C3D_RenderTargetClear wants.
 *       C3D_RenderTargetClear(target, C3D_CLEAR_ALL, abgr_to_rgba8(c->clear_abgr), 0);
 *       continue;
 *     }
 *     apply_depth(c->depth);
 *     apply_flags(c->flags);
 *     if (c->flags & PV_PICA_F_TEXTURED) {
 *       uint8_t need = 0;
 *       int32_t slot = pv_pica_tex_slot(c->page, c->frame, c->pal,
 *                                       (c->flags & PV_PICA_F_TINTED) != 0, &need);
 *       if (slot < 0) continue;
 *       if (need) fill_slot(slot);                 // C3D_TexInit + tex_fill
 *       C3D_TexBind(0, &textures[slot]);
 *     }
 *     upload_mtx(f->matrices + c->mtx * 16);
 *     upload_uv_scale(c->uv_scale);
 *     C3D_SetAttrInfo(c->vfmt == PV_PICA_VFMT_WORLD ? &world : &flat);
 *     C3D_BufInfo buf; BufInfo_Init(&buf);
 *     BufInfo_Add(&buf, f->arena + c->vert_offset, 16,
 *                 c->vfmt == PV_PICA_VFMT_WORLD ? 3 : 2,
 *                 c->vfmt == PV_PICA_VFMT_WORLD ? 0x021 : 0x20);
 *     C3D_SetBufInfo(&buf);
 *     C3D_DrawElements(GPU_TRIANGLES, c->index_count, C3D_UNSIGNED_SHORT,
 *                      f->arena + c->index_offset);
 *   }
 */

#ifdef __cplusplus
}
#endif

#endif /* POCKETVOXEL_PICA_H */
