/*
 * QuickJS on the 3DS: the `globalThis.voxel` surface.
 *
 * On the PSP the op surface lives in Rust (crates/pocketvoxel-psp/src/
 * voxel.rs) because libquickjs-sys binds it there. Here QuickJS is compiled
 * with devkitARM in the container and the Rust staticlib is cross-compiled on
 * macOS without it, so the runtime lives on this side and the ops call
 * through `pocketvoxel_3ds.h`.
 *
 * The surface is ENUMERATED, not transcribed. `contracts/spec/voxel-spec.ts`
 * owns the op names, codes and arities; the crate republishes them as a table
 * through pv3ds_op_count/pv3ds_op_at, and the loop below installs one QuickJS
 * function per entry with the table index as its magic. There is no op name
 * and no op code in this file, so a new op reaches the guest by rebuilding.
 *
 * Argument handling matches the PSP host's: the loop stops at the guest's own
 * argc and the crate zero-fills the rest, so a missing argument reads as 0
 * rather than throwing. Native hosts are the non-strict kind, and a crash on a
 * handheld is worse than a wrong argument.
 */

#include "qjs.h"

#include <string.h>

#include "pocketvoxel_3ds.h"
#include "quickjs.h"

/* The widest op in the table takes 7 numeric arguments (`ent`); the ceiling is
 * a clamp, not a contract, and a wider op simply drops its tail rather than
 * writing past this buffer. */
#define VOXEL_MAX_ARITY 12

/*
 * QuickJS recurses through the interpreter and again through JSON.parse over
 * the pak's 1.15 MB GAME section, which is the deepest thing the guest does.
 * The main thread's own stack is set in main.c.
 */
#define VOXEL_JS_STACK_SIZE (512 * 1024)

static JSRuntime *runtime;
static JSContext *context;
static JSValue global;
static JSValue frame_function;
static char last_error[512];

static void set_error(const char *message) {
  size_t length = message == NULL ? 0 : strlen(message);
  if (length >= sizeof last_error) length = sizeof last_error - 1;
  if (length > 0) memcpy(last_error, message, length);
  last_error[length] = '\0';
}

/* Take the pending exception as the reported error: the capture path writes
 * it to error.txt, so a guest throw surfaces as itself instead of as a
 * timeout. */
static void take_exception(void) {
  JSValue exception = JS_GetException(context);
  size_t length = 0;
  const char *message = JS_ToCStringLen2(context, &length, exception, 0);
  if (message != NULL) {
    size_t copy = length < sizeof last_error - 1 ? length : sizeof last_error - 1;
    memcpy(last_error, message, copy);
    last_error[copy] = '\0';
    JS_FreeCString(context, message);
  } else {
    set_error("QuickJS exception");
  }
  JS_FreeValue(context, exception);
}

// ---------------------------------------------------------------------------
// the op surface
// ---------------------------------------------------------------------------

static JSValue voxel_op(
  JSContext *ctx,
  JSValueConst this_value,
  int argc,
  JSValueConst *argv,
  int magic
) {
  (void)this_value;
  PvVoxOp op;
  if (pv3ds_op_at((uint32_t)magic, &op) != 0) return JS_UNDEFINED;

  int32_t args[VOXEL_MAX_ARITY];
  uint32_t provided = 0;
  uint32_t wanted = op.argc < VOXEL_MAX_ARITY ? op.argc : VOXEL_MAX_ARITY;
  for (; provided < wanted && (int)provided < argc; provided += 1) {
    args[provided] = 0;
    JS_ToInt32(ctx, &args[provided], argv[provided]);
  }

  switch (op.kind) {
    case PV3DS_OP_NUMERIC:
      pv3ds_op(op.code, args, provided);
      return JS_UNDEFINED;

    /* The one string-bearing op: the text follows the numeric arguments. */
    case PV3DS_OP_TEXT: {
      if (argc < (int)op.js_len) return JS_UNDEFINED;
      size_t length = 0;
      const char *text = JS_ToCStringLen2(ctx, &length, argv[op.argc], 0);
      if (text == NULL) return JS_UNDEFINED;
      pv3ds_op_text(op.code, args, provided, text, (uint32_t)length);
      JS_FreeCString(ctx, text);
      return JS_UNDEFINED;
    }

    /* `gamedata()`: the pak's GAME JSON as a string — one cold parse at boot,
     * then the guest never crosses for data again. */
    case PV3DS_OP_GAMEDATA: {
      const uint8_t *bytes = NULL;
      uint32_t length = 0;
      if (pv3ds_gamedata(&bytes, &length) != 0) return JS_UNDEFINED;
      return JS_NewStringLen(ctx, (const char *)bytes, length);
    }

    /* `audiodata()`: the pak's AUDI section as an ArrayBuffer, zero-copy over
     * the leaked pak (free_func NULL — the blob outlives the realm). A -1 here
     * means "this pak has no audio", which the guest reads as run silent. */
    case PV3DS_OP_AUDIODATA: {
      const uint8_t *bytes = NULL;
      uint32_t length = 0;
      if (pv3ds_audiodata(&bytes, &length) != 0) return JS_UNDEFINED;
      return JS_NewArrayBuffer(ctx, (uint8_t *)bytes, length, NULL, NULL, 0);
    }

    /* `stats()`: the counters are for a debug overlay, not for the guest —
     * the PSP host returns undefined and the guest's QuickJsHost expects it. */
    case PV3DS_OP_STATS:
      pv3ds_op_stats(NULL);
      return JS_UNDEFINED;

    default:
      return JS_UNDEFINED;
  }
}

static void install_surface(void) {
  JSValue surface = JS_NewObject(context);
  uint32_t count = pv3ds_op_count();
  for (uint32_t index = 0; index < count; index += 1) {
    PvVoxOp op;
    if (pv3ds_op_at(index, &op) != 0) continue;
    JS_SetPropertyStr(
      context,
      surface,
      op.name,
      JS_NewCFunctionMagic(
        context,
        voxel_op,
        op.name,
        (int)op.js_len,
        JS_CFUNC_generic_magic,
        (int)index
      )
    );
  }
  /* JS_SetPropertyStr consumes ownership of `surface`. */
  JS_SetPropertyStr(context, global, "voxel", surface);
}

static bool drain_jobs(void) {
  for (;;) {
    JSContext *pending = NULL;
    int result = JS_ExecutePendingJob(runtime, &pending);
    if (result > 0) continue;
    if (result < 0) {
      take_exception();
      return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

bool voxel_qjs_boot(const char *source, size_t source_length) {
  last_error[0] = '\0';
  frame_function = JS_UNDEFINED;
  global = JS_UNDEFINED;

  runtime = JS_NewRuntime();
  if (runtime == NULL) {
    set_error("JS_NewRuntime returned null");
    return false;
  }
  JS_SetMaxStackSize(runtime, VOXEL_JS_STACK_SIZE);
  context = JS_NewContext(runtime);
  if (context == NULL) {
    set_error("JS_NewContext returned null");
    return false;
  }
  global = JS_GetGlobalObject(context);
  install_surface();

  JSValue result = JS_Eval(context, source, source_length, "game.js", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(result)) {
    take_exception();
    return false;
  }
  JS_FreeValue(context, result);

  frame_function = JS_GetPropertyStr(context, global, "frame");
  if (!JS_IsFunction(context, frame_function)) {
    set_error("game.js did not install globalThis.frame");
    return false;
  }
  return drain_jobs();
}

bool voxel_qjs_frame(int32_t buttons) {
  if (context == NULL) return false;
  JSValue argument = JS_NewInt32(context, buttons);
  JSValue result = JS_Call(context, frame_function, global, 1, &argument);
  JS_FreeValue(context, argument);
  if (JS_IsException(result)) {
    take_exception();
    JS_FreeValue(context, result);
    return false;
  }
  /* Leak guard: the return value is freed every tick. */
  JS_FreeValue(context, result);
  return drain_jobs();
}

/*
 * Collect now, because now is the cheap moment.
 *
 * QuickJS here runs on newlib's malloc rather than the PSP EBOOT's fixed
 * arena, so there is no arena pressure to watch — but the other half of that
 * lesson still applies: a collection is a visible hitch mid-walk and an
 * invisible held cut on a warp landing, where the guest holds the world frozen
 * through the fade. The crate reports that landing (pv3ds_take_map_swapped)
 * and map loads are exactly what balloon the heap in the first place.
 */
void voxel_qjs_collect(void) {
  if (runtime != NULL) JS_RunGC(runtime);
}

const char *voxel_qjs_last_error(void) {
  return last_error;
}

void voxel_qjs_shutdown(void) {
  if (context != NULL) {
    JS_FreeValue(context, frame_function);
    JS_FreeValue(context, global);
    JS_FreeContext(context);
    context = NULL;
  }
  if (runtime != NULL) {
    JS_FreeRuntime(runtime);
    runtime = NULL;
  }
  frame_function = JS_UNDEFINED;
  global = JS_UNDEFINED;
}
