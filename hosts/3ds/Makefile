# Pocket Voxel 3DS host — run INSIDE the devkitpro/devkitarm container.
#
# tools/voxel-3ds.ts builds the Rust staticlib and QuickJS first, then invokes
# this with CWD hosts/3ds and every path already translated to a container
# path. All inputs arrive as ENVIRONMENT variables, so the recipes below only
# ever read them:
#
#   PV3DS_APP_LIB          libpocketvoxel_3ds.a (the app crate's staticlib)
#   PV3DS_APP_INCLUDE      crates/pocketvoxel-3ds/include
#   PV3DS_PICA_INCLUDE     crates/pocketvoxel-pica/include
#   PV3DS_QUICKJS_DIR      directory holding quickjs.h and libquickjs.a
#   PV3DS_GAME_JS          the guest bundle to embed
#   PV3DS_PAK              the cooked .vxpak to embed
#   PV3DS_BUILD_DIR        scratch for objects, the .shbin, the .elf, romfs
#   PV3DS_OUT_3DSX         the .3dsx to write
#   PV3DS_SMDH_TITLE       SMDH metadata
#   PV3DS_SMDH_AUTHOR
#   PV3DS_SMDH_DESC
#   PV3DS_CAPTURE          "1" builds the deterministic e2e binary
#   PV3DS_CAPTURE_INPUT    baked input tape, "tick:mask,tick:mask"
#   PV3DS_CAPTURE_MARKS    baked mark ticks, "tick,tick,…"
#
# The memory knobs are PV3DS_HOST_* so they cannot collide with the contract
# values PV3DS_ARENA_BYTES / PV3DS_ARENA_BANKS that the crate's own header
# defines. Zero means "the crate's default" for the arena pair and "libctru's
# automatic split" for the heap pair.
#
#   PV3DS_HOST_ARENA_MIB   staging arena size; 0 = PV3DS_ARENA_BYTES
#   PV3DS_HOST_ARENA_BANKS bank count;         0 = PV3DS_ARENA_BANKS
#   PV3DS_HOST_TEXTURE_MIB linear memory held back for the expanded textures
#   PV3DS_HOST_HEAP_MIB    libctru heap override; 0 = automatic
#   PV3DS_HOST_LINEAR_MIB  libctru linear heap override; 0 = automatic
#
# The tape and the marks travel INSIDE the binary: a capture run never reads
# the emulator's filesystem for its input. Nothing is written outside
# PV3DS_BUILD_DIR and PV3DS_OUT_3DSX.
#
# NO ROM-DERIVED BYTE EVER COMMITS. Both embedded files come from git-ignored
# dist/, and so does the .3dsx.

DEVKITPRO ?= /opt/devkitpro
DEVKITARM ?= $(DEVKITPRO)/devkitARM

SOURCE := $(CURDIR)/src
BUILD := $(PV3DS_BUILD_DIR)
OUT := $(PV3DS_OUT_3DSX)
# 3dsxtool reads the embedded files out of a RomFS directory, so the guest and
# the pak are staged under one.
ROMFS := $(BUILD)/romfs
ICON ?= $(CURDIR)/icon.png

CC := $(DEVKITARM)/bin/arm-none-eabi-gcc
PICASSO := $(DEVKITPRO)/tools/bin/picasso
BIN2S := $(DEVKITPRO)/tools/bin/bin2s
SMDHTOOL := $(DEVKITPRO)/tools/bin/smdhtool
THREEDSXTOOL := $(DEVKITPRO)/tools/bin/3dsxtool

# The ARM11 in both console revisions: ARMv6K, MPCore tuning, hardware float,
# and the soft thread pointer libctru is built against. -mword-relocations is
# what keeps the 3dsx loader's relocation table expressible.
ARCH := -march=armv6k -mtune=mpcore -mfloat-abi=hard -mtp=soft

# JS_NO_NAN_BOXING is not optional and not cosmetic: quickjs.h turns NaN boxing
# ON by default for any 32-bit target, which makes JSValue 8 bytes instead of
# 16. libquickjs.a is built with it defined (the Vita treatment in
# libquickjs-sys/build.rs), so a translation unit that includes quickjs.h
# without it links cleanly and then hands the library differently shaped
# values — the guest boots and QuickJS's GC walks garbage pointers.
#
# The two crate headers are the whole contract this host compiles against:
# pocketvoxel_3ds.h for the Scene and the op table, pocketvoxel_pica.h for the
# recorded command stream.
CFLAGS := -Wall -Wextra -O2 -g -std=gnu11 -mword-relocations -ffunction-sections -fdata-sections \
  $(ARCH) -D__3DS__ -DJS_NO_NAN_BOXING \
  -DPV3DS_HOST_ARENA_MIB=$(PV3DS_HOST_ARENA_MIB) \
  -DPV3DS_HOST_ARENA_BANKS=$(PV3DS_HOST_ARENA_BANKS) \
  -DPV3DS_HOST_TEXTURE_MIB=$(PV3DS_HOST_TEXTURE_MIB) \
  -DPV3DS_HOST_HEAP_MIB=$(PV3DS_HOST_HEAP_MIB) \
  -DPV3DS_HOST_LINEAR_MIB=$(PV3DS_HOST_LINEAR_MIB) \
  -I$(PV3DS_APP_INCLUDE) -I$(PV3DS_PICA_INCLUDE) -I$(BUILD) \
  -I$(PV3DS_QUICKJS_DIR) -I$(DEVKITPRO)/libctru/include

ifeq ($(PV3DS_CAPTURE),1)
CFLAGS += -DPV3DS_CAPTURE \
  -DPV3DS_CAPTURE_INPUT='"$(PV3DS_CAPTURE_INPUT)"' \
  -DPV3DS_CAPTURE_MARKS='"$(PV3DS_CAPTURE_MARKS)"'
endif

LDFLAGS := -specs=3dsx.specs $(ARCH) -Wl,--gc-sections -Wl,-Map,$(BUILD)/pocketvoxel-3ds.map
LIBPATHS := -L$(DEVKITPRO)/libctru/lib
LIBS := -lcitro3d -lctru -lm

OBJECTS := $(BUILD)/main.o $(BUILD)/voxel_gfx.o $(BUILD)/qjs.o $(BUILD)/input.o \
  $(BUILD)/vshader_shbin.o
ELF := $(BUILD)/pocketvoxel-3ds.elf
SMDH := $(BUILD)/pocketvoxel-3ds.smdh

.PHONY: all clean
all: $(OUT)

$(BUILD) $(ROMFS):
	mkdir -p $@

# The PICA200 vertex shader is assembled and linked in as data; there is no
# fragment shader on this GPU (voxel_gfx.c drives TEV stages instead).
$(BUILD)/vshader.shbin: $(SOURCE)/vshader.v.pica | $(BUILD)
	$(PICASSO) -o $@ $<

$(BUILD)/vshader_shbin.s $(BUILD)/vshader_shbin.h: $(BUILD)/vshader.shbin
	cd $(BUILD) && $(BIN2S) -a 4 -H vshader_shbin.h vshader.shbin > vshader_shbin.s

$(BUILD)/vshader_shbin.o: $(BUILD)/vshader_shbin.s
	$(CC) $(ARCH) -c $< -o $@

# The input tape, the mark list and every memory knob reach the C sources as
# -D defines, so a rebuild driven by source mtimes alone would keep a previous
# run's values — a stale tape or a shifted mark set produces a plausible .3dsx
# that dumps the wrong frames. Objects therefore depend on a stamp carrying
# the flags themselves, rewritten only when they actually change (the
# make-side counterpart of cargo:rerun-if-env-changed).
FLAGS_STAMP := $(BUILD)/cflags.stamp
.PHONY: $(FLAGS_STAMP).probe
$(FLAGS_STAMP).probe: | $(BUILD)
	@printf '%s\n' "$(CFLAGS)" > $(FLAGS_STAMP).new
	@cmp -s $(FLAGS_STAMP).new $(FLAGS_STAMP) || mv $(FLAGS_STAMP).new $(FLAGS_STAMP)
	@rm -f $(FLAGS_STAMP).new
$(FLAGS_STAMP): $(FLAGS_STAMP).probe ;

$(BUILD)/%.o: $(SOURCE)/%.c $(BUILD)/vshader_shbin.h $(FLAGS_STAMP) | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@

$(ELF): $(OBJECTS) $(PV3DS_APP_LIB)
	$(CC) $(LDFLAGS) $(OBJECTS) $(PV3DS_APP_LIB) $(PV3DS_QUICKJS_DIR)/libquickjs.a \
	  $(LIBPATHS) $(LIBS) -o $@

$(ROMFS)/game.js: $(PV3DS_GAME_JS) | $(ROMFS)
	cp $< $@

# The pak is 32 MB, so this copy is guarded by its own mtime rule rather than
# repeated on every build.
$(ROMFS)/voxelmon.vxpak: $(PV3DS_PAK) | $(ROMFS)
	cp $< $@

# 3dsxtool refuses to embed a RomFS without SMDH metadata, so one is always
# built.
$(SMDH): $(ICON) | $(BUILD)
	$(SMDHTOOL) --create "$(PV3DS_SMDH_TITLE)" "$(PV3DS_SMDH_DESC)" \
	  "$(PV3DS_SMDH_AUTHOR)" $(ICON) $@

$(OUT): $(ELF) $(SMDH) $(ROMFS)/game.js $(ROMFS)/voxelmon.vxpak
	mkdir -p $(dir $(OUT))
	$(THREEDSXTOOL) $(ELF) $@ --romfs=$(ROMFS) --smdh=$(SMDH)

clean:
	rm -rf $(BUILD) $(OUT)
