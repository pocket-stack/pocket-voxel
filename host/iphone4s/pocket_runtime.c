#include "../../vendor/pocketjs/hosts/iphone2g/pocket_runtime.h"

#include "quickjs.h"

#include <AudioToolbox/AudioQueue.h>
#include <AudioToolbox/AudioSession.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

extern int pocketvoxel_boot(const uint8_t *bytes, size_t length);
extern const char *pocketvoxel_error(void);
extern const uint8_t *pocketvoxel_game(size_t *length);
extern const uint8_t *pocketvoxel_audio(size_t *length);
extern void pocketvoxel_op(
  uint32_t code,
  const int32_t *arguments,
  size_t argument_count,
  const uint8_t *string,
  size_t string_length
);
extern void pocketvoxel_tick(void);
extern int pocketvoxel_render(int width, int height, uint32_t buttons);
extern size_t pocketvoxel_audio_render(int16_t *output, size_t frames);
extern int pocketvoxel_gl_initialize(int width, int height);
extern void pocketvoxel_gl_shutdown(void);
extern void pocketvoxel_shutdown(void);

#define AUDIO_STATUS_PATH "/private/var/tmp/pocketvoxel-iphone4s.audio"
#define AUDIO_STATUS_TEMP "/private/var/tmp/pocketvoxel-iphone4s.audio.new"
#define AUDIO_BUFFER_COUNT 4
#define AUDIO_BUFFER_FRAMES 735
#define AUDIO_BUFFER_BYTES (AUDIO_BUFFER_FRAMES * 2 * sizeof(int16_t))

enum {
  OP_GAMEDATA = 1,
  OP_STATS = 2,
  OP_RESET = 3,
  OP_MAP_SHOW = 10,
  OP_MAP_HIDE = 11,
  OP_CAM = 12,
  OP_PITCH = 13,
  OP_TINT = 14,
  OP_STAMP = 15,
  OP_PALETTE = 16,
  OP_AUDIODATA = 17,
  OP_MUSIC = 18,
  OP_MUSIC_STOP = 19,
  OP_MUSIC_FADE = 20,
  OP_SFX = 21,
  OP_CRY = 22,
  OP_AUDIO_WAVES = 23,
  OP_AUDIO_DRUM = 24,
  OP_ENT = 30,
  OP_ENT_HIDE = 31,
  OP_EMOTE = 32,
  OP_UI_TILE = 50,
  OP_UI_FILL = 51,
  OP_UI_TEXT = 52,
  OP_UI_REVEAL = 53,
  OP_UI_CLEAR = 54,
  OP_UI_RECT = 55,
  OP_UI_LABEL = 56,
  OP_UI_OVERLAY_CLEAR = 57,
  OP_REMOTE_PLANE = 58,
  OP_ARENA = 70,
  OP_CARD = 71,
  OP_CARD_HIDE = 72,
  OP_BATTLE_CAM = 73,
  OP_ARENA_END = 74,
  OP_SKY = 75
};

enum {
  BTN_UP = 1,
  BTN_DOWN = 2,
  BTN_LEFT = 4,
  BTN_RIGHT = 8,
  BTN_A = 16,
  BTN_B = 32,
  BTN_START = 64,
  BTN_SELECT = 128
};

static JSRuntime *runtime;
static JSContext *context;
static JSValue global;
static JSValue frame_function;
static char last_error[512];
static uint32_t buttons;
static uint32_t previous_buttons;
static unsigned long action_sequence;
static pthread_mutex_t scene_lock = PTHREAD_MUTEX_INITIALIZER;
static AudioQueueRef audio_queue;
static AudioQueueBufferRef audio_buffers[AUDIO_BUFFER_COUNT];
static unsigned long audio_callbacks;
static unsigned long audio_frames;
static unsigned long audio_nonzero_buffers;
static int audio_peak;
static unsigned long runtime_frames;
static int audio_failed;
static char audio_state[16] = "stopped";
static char audio_error[96];

static void set_error(const char *message) {
  size_t length = message == NULL ? 0 : strlen(message);
  if (length >= sizeof(last_error)) length = sizeof(last_error) - 1;
  if (length > 0) memcpy(last_error, message, length);
  last_error[length] = '\0';
}

static void set_audio_error(const char *operation, OSStatus status) {
  snprintf(audio_error, sizeof(audio_error), "%s failed (%ld)", operation, (long)status);
  memcpy(audio_state, "failed", sizeof("failed"));
  audio_failed = 1;
}

static void write_audio_status(void) {
  FILE *file;
  unsigned long callbacks;
  unsigned long frames;
  unsigned long nonzero_buffers;
  int peak;
  char state[sizeof(audio_state)];
  char error[sizeof(audio_error)];
  pthread_mutex_lock(&scene_lock);
  callbacks = audio_callbacks;
  frames = audio_frames;
  nonzero_buffers = audio_nonzero_buffers;
  peak = audio_peak;
  memcpy(state, audio_state, sizeof(state));
  memcpy(error, audio_error, sizeof(error));
  pthread_mutex_unlock(&scene_lock);
  file = fopen(AUDIO_STATUS_TEMP, "w");
  if (file == NULL) return;
  fprintf(
    file,
    "audio_state=%s\naudio_rate=11025\naudio_channels=2\n"
    "audio_callbacks=%lu\naudio_frames=%lu\naudio_nonzero_buffers=%lu\n"
    "audio_peak=%d\naudio_error=%s\n",
    state,
    callbacks,
    frames,
    nonzero_buffers,
    peak,
    error
  );
  if (fflush(file) != 0 || fclose(file) != 0) {
    remove(AUDIO_STATUS_TEMP);
    return;
  }
  if (rename(AUDIO_STATUS_TEMP, AUDIO_STATUS_PATH) != 0) remove(AUDIO_STATUS_TEMP);
}

static int fill_audio_buffer(AudioQueueRef queue, AudioQueueBufferRef buffer) {
  size_t rendered;
  size_t sample_index;
  int peak = 0;
  OSStatus status;
  pthread_mutex_lock(&scene_lock);
  rendered = pocketvoxel_audio_render((int16_t *)buffer->mAudioData, AUDIO_BUFFER_FRAMES);
  if (rendered != AUDIO_BUFFER_FRAMES) {
    memset(buffer->mAudioData, 0, AUDIO_BUFFER_BYTES);
    set_audio_error("pocketvoxel_audio_render", -1);
    pthread_mutex_unlock(&scene_lock);
    return 0;
  }
  for (sample_index = 0; sample_index < AUDIO_BUFFER_FRAMES * 2; sample_index += 1) {
    int sample = ((int16_t *)buffer->mAudioData)[sample_index];
    int magnitude = sample < 0 ? -sample : sample;
    if (magnitude > peak) peak = magnitude;
  }
  buffer->mAudioDataByteSize = AUDIO_BUFFER_BYTES;
  status = AudioQueueEnqueueBuffer(queue, buffer, 0, NULL);
  if (status != noErr) {
    set_audio_error("AudioQueueEnqueueBuffer", status);
    pthread_mutex_unlock(&scene_lock);
    return 0;
  }
  audio_frames += AUDIO_BUFFER_FRAMES;
  if (peak > 0) audio_nonzero_buffers += 1;
  if (peak > audio_peak) audio_peak = peak;
  pthread_mutex_unlock(&scene_lock);
  return 1;
}

static void audio_output_callback(
  void *user_data,
  AudioQueueRef queue,
  AudioQueueBufferRef buffer
) {
  (void)user_data;
  pthread_mutex_lock(&scene_lock);
  audio_callbacks += 1;
  pthread_mutex_unlock(&scene_lock);
  (void)fill_audio_buffer(queue, buffer);
}

static int start_audio(void) {
  AudioStreamBasicDescription format;
  UInt32 category = kAudioSessionCategory_MediaPlayback;
  OSStatus status;
  int index;
  memset(&format, 0, sizeof(format));
  memset(audio_buffers, 0, sizeof(audio_buffers));
  audio_callbacks = 0;
  audio_frames = 0;
  audio_nonzero_buffers = 0;
  audio_peak = 0;
  audio_failed = 0;
  audio_error[0] = '\0';
  memcpy(audio_state, "starting", sizeof("starting"));

  status = AudioSessionInitialize(NULL, NULL, NULL, NULL);
  if (status != noErr && status != kAudioSessionAlreadyInitialized) {
    set_audio_error("AudioSessionInitialize", status);
    goto failed;
  }
  status = AudioSessionSetProperty(
    kAudioSessionProperty_AudioCategory,
    sizeof(category),
    &category
  );
  if (status != noErr) {
    set_audio_error("AudioSessionSetProperty", status);
    goto failed;
  }
  status = AudioSessionSetActive(1);
  if (status != noErr) {
    set_audio_error("AudioSessionSetActive", status);
    goto failed;
  }

  format.mSampleRate = 11025.0;
  format.mFormatID = kAudioFormatLinearPCM;
  format.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked;
  format.mBytesPerPacket = 4;
  format.mFramesPerPacket = 1;
  format.mBytesPerFrame = 4;
  format.mChannelsPerFrame = 2;
  format.mBitsPerChannel = 16;
  status = AudioQueueNewOutput(&format, audio_output_callback, NULL, NULL, NULL, 0, &audio_queue);
  if (status != noErr) {
    set_audio_error("AudioQueueNewOutput", status);
    goto failed;
  }
  for (index = 0; index < AUDIO_BUFFER_COUNT; index += 1) {
    status = AudioQueueAllocateBuffer(audio_queue, AUDIO_BUFFER_BYTES, &audio_buffers[index]);
    if (status != noErr) {
      set_audio_error("AudioQueueAllocateBuffer", status);
      goto failed;
    }
    if (!fill_audio_buffer(audio_queue, audio_buffers[index])) goto failed;
  }
  status = AudioQueueStart(audio_queue, NULL);
  if (status != noErr) {
    set_audio_error("AudioQueueStart", status);
    goto failed;
  }
  pthread_mutex_lock(&scene_lock);
  memcpy(audio_state, "running", sizeof("running"));
  pthread_mutex_unlock(&scene_lock);
  write_audio_status();
  return 1;

failed:
  if (audio_queue != NULL) {
    AudioQueueDispose(audio_queue, 1);
    audio_queue = NULL;
  }
  AudioSessionSetActive(0);
  set_error(audio_error);
  write_audio_status();
  return 0;
}

static void stop_audio(void) {
  if (audio_queue != NULL) {
    AudioQueueStop(audio_queue, 1);
    AudioQueueDispose(audio_queue, 1);
    audio_queue = NULL;
  }
  AudioSessionSetActive(0);
  pthread_mutex_lock(&scene_lock);
  if (!audio_failed) memcpy(audio_state, "stopped", sizeof("stopped"));
  pthread_mutex_unlock(&scene_lock);
  write_audio_status();
}

static void take_exception(JSContext *ctx) {
  JSValue exception = JS_GetException(ctx);
  size_t length = 0;
  const char *message = JS_ToCStringLen2(ctx, &length, exception, 0);
  if (message != NULL) {
    size_t copy = length < sizeof(last_error) - 1 ? length : sizeof(last_error) - 1;
    memcpy(last_error, message, copy);
    last_error[copy] = '\0';
    JS_FreeCString(ctx, message);
  } else {
    set_error("QuickJS exception");
  }
  JS_FreeValue(ctx, exception);
}

static int32_t argument(JSContext *ctx, int argc, JSValueConst *argv, int index) {
  int32_t value = 0;
  if (index < argc) JS_ToInt32(ctx, &value, argv[index]);
  return value;
}

static JSValue dispatch(
  JSContext *ctx,
  JSValueConst this_value,
  int argc,
  JSValueConst *argv,
  int magic
) {
  int32_t args[7];
  int index;
  (void)this_value;
  for (index = 0; index < 7; index += 1) args[index] = argument(ctx, argc, argv, index);
  pthread_mutex_lock(&scene_lock);
  pocketvoxel_op((uint32_t)magic, args, (size_t)(argc < 7 ? argc : 7), NULL, 0);
  pthread_mutex_unlock(&scene_lock);
  return JS_UNDEFINED;
}

static JSValue dispatch_string(
  JSContext *ctx,
  JSValueConst this_value,
  int argc,
  JSValueConst *argv,
  int magic
) {
  int numeric_count = magic == OP_UI_TEXT ? 2 : 4;
  int32_t args[4];
  const char *text;
  size_t length = 0;
  int index;
  (void)this_value;
  for (index = 0; index < numeric_count; index += 1) {
    args[index] = argument(ctx, argc, argv, index);
  }
  if (argc <= numeric_count) return JS_UNDEFINED;
  text = JS_ToCStringLen2(ctx, &length, argv[numeric_count], 0);
  if (text == NULL) return JS_EXCEPTION;
  pthread_mutex_lock(&scene_lock);
  pocketvoxel_op((uint32_t)magic, args, (size_t)numeric_count, (const uint8_t *)text, length);
  pthread_mutex_unlock(&scene_lock);
  JS_FreeCString(ctx, text);
  return JS_UNDEFINED;
}

static JSValue js_gamedata(
  JSContext *ctx,
  JSValueConst this_value,
  int argc,
  JSValueConst *argv
) {
  size_t length = 0;
  const uint8_t *data;
  (void)this_value;
  (void)argc;
  (void)argv;
  pthread_mutex_lock(&scene_lock);
  data = pocketvoxel_game(&length);
  pocketvoxel_op(OP_GAMEDATA, NULL, 0, NULL, 0);
  pthread_mutex_unlock(&scene_lock);
  return JS_NewStringLen(ctx, (const char *)data, length);
}

static JSValue js_audiodata(
  JSContext *ctx,
  JSValueConst this_value,
  int argc,
  JSValueConst *argv
) {
  size_t length = 0;
  const uint8_t *data;
  (void)this_value;
  (void)argc;
  (void)argv;
  pthread_mutex_lock(&scene_lock);
  data = pocketvoxel_audio(&length);
  pocketvoxel_op(OP_AUDIODATA, NULL, 0, NULL, 0);
  pthread_mutex_unlock(&scene_lock);
  if (data == NULL || length == 0) return JS_UNDEFINED;
  return JS_NewArrayBuffer(ctx, (uint8_t *)data, length, NULL, NULL, 0);
}

static JSValue js_stats(
  JSContext *ctx,
  JSValueConst this_value,
  int argc,
  JSValueConst *argv
) {
  (void)ctx;
  (void)this_value;
  (void)argc;
  (void)argv;
  pthread_mutex_lock(&scene_lock);
  pocketvoxel_op(OP_STATS, NULL, 0, NULL, 0);
  pthread_mutex_unlock(&scene_lock);
  return JS_UNDEFINED;
}

static JSValue js_remote_open(
  JSContext *ctx,
  JSValueConst this_value,
  int argc,
  JSValueConst *argv
) {
  (void)this_value;
  (void)argc;
  (void)argv;
  return JS_NewBool(ctx, 0);
}

static JSValue js_remote_tick(
  JSContext *ctx,
  JSValueConst this_value,
  int argc,
  JSValueConst *argv
) {
  (void)this_value;
  (void)argc;
  (void)argv;
  return JS_NewInt32(ctx, -2);
}

static JSValue js_remote_close(
  JSContext *ctx,
  JSValueConst this_value,
  int argc,
  JSValueConst *argv
) {
  (void)ctx;
  (void)this_value;
  (void)argc;
  (void)argv;
  return JS_UNDEFINED;
}

static void add_magic(
  JSContext *ctx,
  JSValue object,
  const char *name,
  JSCFunctionMagic *function,
  int arguments,
  int operation
) {
  JSValue value = JS_NewCFunction2(
    ctx,
    (JSCFunction *)function,
    name,
    arguments,
    JS_CFUNC_generic_magic,
    operation
  );
  JS_SetPropertyStr(ctx, object, name, value);
}

static void add_plain(
  JSContext *ctx,
  JSValue object,
  const char *name,
  JSCFunction *function,
  int arguments
) {
  JS_SetPropertyStr(ctx, object, name, JS_NewCFunction(ctx, function, name, arguments));
}

static void register_voxel(JSContext *ctx, JSValue root) {
  JSValue voxel = JS_NewObject(ctx);
  add_plain(ctx, voxel, "gamedata", js_gamedata, 0);
  add_plain(ctx, voxel, "audiodata", js_audiodata, 0);
  add_plain(ctx, voxel, "stats", js_stats, 0);
  add_magic(ctx, voxel, "reset", dispatch, 0, OP_RESET);
  add_magic(ctx, voxel, "mapShow", dispatch, 4, OP_MAP_SHOW);
  add_magic(ctx, voxel, "mapHide", dispatch, 1, OP_MAP_HIDE);
  add_magic(ctx, voxel, "cam", dispatch, 2, OP_CAM);
  add_magic(ctx, voxel, "pitch", dispatch, 1, OP_PITCH);
  add_magic(ctx, voxel, "tint", dispatch, 1, OP_TINT);
  add_magic(ctx, voxel, "sky", dispatch, 1, OP_SKY);
  add_magic(ctx, voxel, "stamp", dispatch, 4, OP_STAMP);
  add_magic(ctx, voxel, "palette", dispatch, 1, OP_PALETTE);
  add_magic(ctx, voxel, "ent", dispatch, 7, OP_ENT);
  add_magic(ctx, voxel, "entHide", dispatch, 1, OP_ENT_HIDE);
  add_magic(ctx, voxel, "emote", dispatch, 2, OP_EMOTE);
  add_magic(ctx, voxel, "uiTile", dispatch, 3, OP_UI_TILE);
  add_magic(ctx, voxel, "uiFill", dispatch, 5, OP_UI_FILL);
  add_magic(ctx, voxel, "uiText", dispatch_string, 3, OP_UI_TEXT);
  add_magic(ctx, voxel, "uiReveal", dispatch, 1, OP_UI_REVEAL);
  add_magic(ctx, voxel, "uiClear", dispatch, 0, OP_UI_CLEAR);
  add_magic(ctx, voxel, "uiRect", dispatch, 5, OP_UI_RECT);
  add_magic(ctx, voxel, "uiLabel", dispatch_string, 5, OP_UI_LABEL);
  add_magic(ctx, voxel, "uiOverlayClear", dispatch, 0, OP_UI_OVERLAY_CLEAR);
  add_magic(ctx, voxel, "remotePlane", dispatch, 4, OP_REMOTE_PLANE);
  add_plain(ctx, voxel, "remoteOpen", js_remote_open, 0);
  add_plain(ctx, voxel, "remoteTick", js_remote_tick, 0);
  add_plain(ctx, voxel, "remoteClose", js_remote_close, 0);
  add_magic(ctx, voxel, "arena", dispatch, 5, OP_ARENA);
  add_magic(ctx, voxel, "card", dispatch, 4, OP_CARD);
  add_magic(ctx, voxel, "cardHide", dispatch, 1, OP_CARD_HIDE);
  add_magic(ctx, voxel, "battleCam", dispatch, 3, OP_BATTLE_CAM);
  add_magic(ctx, voxel, "arenaEnd", dispatch, 0, OP_ARENA_END);
  add_magic(ctx, voxel, "music", dispatch, 4, OP_MUSIC);
  add_magic(ctx, voxel, "musicStop", dispatch, 0, OP_MUSIC_STOP);
  add_magic(ctx, voxel, "musicFade", dispatch, 1, OP_MUSIC_FADE);
  add_magic(ctx, voxel, "sfx", dispatch, 6, OP_SFX);
  add_magic(ctx, voxel, "cry", dispatch, 5, OP_CRY);
  add_magic(ctx, voxel, "audioWaves", dispatch, 3, OP_AUDIO_WAVES);
  add_magic(ctx, voxel, "audioDrum", dispatch, 4, OP_AUDIO_DRUM);
  JS_SetPropertyStr(ctx, root, "voxel", voxel);
}

static uint32_t touch_buttons(int down, int x, int y) {
  int dx;
  int dy;
  int abs_x;
  int abs_y;
  if (!down || y < 240) return 0;

  dx = x - 75;
  dy = y - 350;
  abs_x = dx < 0 ? -dx : dx;
  abs_y = dy < 0 ? -dy : dy;
  if ((abs_x <= 23 && abs_y <= 65) || (abs_y <= 23 && abs_x <= 65)) {
    if (abs_x > abs_y && abs_x > 12) return dx < 0 ? BTN_LEFT : BTN_RIGHT;
    if (abs_y > 12) return dy < 0 ? BTN_UP : BTN_DOWN;
  }

  dx = x - 260;
  dy = y - 320;
  if (dx * dx + dy * dy <= 42 * 42) return BTN_A;
  dx = x - 202;
  dy = y - 375;
  if (dx * dx + dy * dy <= 40 * 40) return BTN_B;
  if (x >= 98 && x <= 144 && y >= 448 && y <= 474) return BTN_SELECT;
  if (x >= 169 && x <= 215 && y >= 448 && y <= 474) return BTN_START;
  return 0;
}

int pocket_runtime_boot(
  const char *java_script,
  size_t java_script_length,
  const uint8_t *pack,
  size_t pack_length,
  int width,
  int height
) {
  JSValue result;
  (void)width;
  (void)height;
  set_error("");
  if (!pocketvoxel_boot(pack, pack_length)) {
    set_error(pocketvoxel_error());
    return 0;
  }
  runtime = JS_NewRuntime();
  if (runtime == NULL) {
    set_error("JS_NewRuntime returned null");
    return 0;
  }
  context = JS_NewContext(runtime);
  if (context == NULL) {
    set_error("JS_NewContext returned null");
    return 0;
  }
  global = JS_GetGlobalObject(context);
  register_voxel(context, global);
  result = JS_Eval(
    context,
    java_script,
    java_script_length,
    "voxelmon.js",
    JS_EVAL_TYPE_GLOBAL
  );
  if (JS_IsException(result)) {
    take_exception(context);
    JS_FreeValue(context, result);
    return 0;
  }
  JS_FreeValue(context, result);
  frame_function = JS_GetPropertyStr(context, global, "frame");
  if (!JS_IsFunction(context, frame_function)) {
    set_error("globalThis.frame is missing");
    return 0;
  }
  if (!start_audio()) return 0;
  return 1;
}

int pocket_runtime_frame(int touch_down, int touch_x, int touch_y, int touch_hit) {
  JSValue argument;
  JSValue result;
  JSContext *pending;
  int job;
  (void)touch_hit;
  if (context == NULL) return 0;
  buttons = touch_buttons(touch_down, touch_x, touch_y);
  if (buttons != 0 && buttons != previous_buttons) action_sequence += 1;
  previous_buttons = buttons;
  argument = JS_NewInt32(context, (int32_t)buttons);
  result = JS_Call(context, frame_function, global, 1, &argument);
  JS_FreeValue(context, argument);
  if (JS_IsException(result)) {
    take_exception(context);
    JS_FreeValue(context, result);
    return 0;
  }
  JS_FreeValue(context, result);
  for (;;) {
    pending = NULL;
    job = JS_ExecutePendingJob(runtime, &pending);
    if (job > 0) continue;
    if (job < 0) {
      take_exception(pending == NULL ? context : pending);
      return 0;
    }
    break;
  }
  pthread_mutex_lock(&scene_lock);
  pocketvoxel_tick();
  runtime_frames += 1;
  if (audio_failed) {
    set_error(audio_error);
    pthread_mutex_unlock(&scene_lock);
    write_audio_status();
    return 0;
  }
  pthread_mutex_unlock(&scene_lock);
  if (runtime_frames % 30 == 0) write_audio_status();
  return 1;
}

int pocket_runtime_frame_ticks(
  int touch_down,
  int touch_x,
  int touch_y,
  int touch_hit,
  unsigned int tick_count
) {
  unsigned int index;
  for (index = 0; index < tick_count; index += 1) {
    if (!pocket_runtime_frame(touch_down, touch_x, touch_y, touch_hit)) return 0;
  }
  return 1;
}

int pocket_runtime_hit_test(float x, float y) {
  return touch_buttons(1, (int)x, (int)y) != 0;
}

int pocket_runtime_hit_test_bounds(float x, float y) {
  return pocket_runtime_hit_test(x, y);
}

const char *pocket_runtime_action_name(void) {
  return action_sequence == 0 ? "" : "voxel_input";
}

int pocket_runtime_action_value(void) {
  return (int)buttons;
}

unsigned long pocket_runtime_action_sequence(void) {
  return action_sequence;
}

const uint8_t *pocket_runtime_render(void) { return NULL; }
unsigned long pocket_runtime_damage_attempts(void) { return 0; }
unsigned long pocket_runtime_damage_failures(void) { return 0; }
unsigned long pocket_runtime_damage_full_redraws(void) { return 0; }
unsigned long pocket_runtime_damage_pixels(void) { return 0; }
int pocket_runtime_damage_bounds(int *bounds) { (void)bounds; return 0; }

int pocket_runtime_gl_initialize(void) {
  int initialized;
  pthread_mutex_lock(&scene_lock);
  initialized = pocketvoxel_gl_initialize(640, 960);
  pthread_mutex_unlock(&scene_lock);
  return initialized;
}

int pocket_runtime_gl_render(int width, int height) {
  int rendered;
  pthread_mutex_lock(&scene_lock);
  rendered = pocketvoxel_render(width, height, buttons);
  pthread_mutex_unlock(&scene_lock);
  return rendered;
}

void pocket_runtime_gl_shutdown(void) {
  pthread_mutex_lock(&scene_lock);
  pocketvoxel_gl_shutdown();
  pthread_mutex_unlock(&scene_lock);
}

uint32_t pocket_runtime_width(void) { return 320; }
uint32_t pocket_runtime_height(void) { return 480; }
uint32_t pocket_runtime_stride(void) { return 0; }
size_t pocket_runtime_length(void) { return 0; }
const char *pocket_runtime_error(void) { return last_error; }

void pocket_runtime_shutdown(void) {
  stop_audio();
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
  pthread_mutex_lock(&scene_lock);
  pocketvoxel_shutdown();
  pthread_mutex_unlock(&scene_lock);
}
