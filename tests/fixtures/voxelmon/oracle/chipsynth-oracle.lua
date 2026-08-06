-- Chip-synth oracle: loads the REFERENCE gen1recomp ChipSynth.lua and renders
-- one program to raw PCM, so the Rust core synth
-- (engine/pocketvoxel/crates/pocketvoxel-core/src/audio.rs) can be compared
-- against the thing it ports rather than against another port of it.
--
--   luajit chipsynth-oracle.lua <gen1recomp-root> <params.lua> <out.pcm>
--
-- <params.lua> is a Lua chunk returning the numbers tests/voxel-audio.test.ts
-- resolved out of dist/voxelmon/gen/audio.json — the same numbers the voxel
-- surface's audio ops carry, so both sides start from identical inputs:
--
--   {
--     programFile = "<abs path to programs.bin>",
--     bankOrder   = { 2, 8, 31 },
--     waveBanks   = { ["1"] = { bank = 2, address = 17267 }, ... },
--     noiseHeaders= { ["1"] = { ["1"] = { bank = 2, address = 16387 }, ... } },
--     header      = { bank = 2, address = 16942, engine = 1 },
--     mode        = "music" | "effect",
--     frames      = 220500,          -- music: exactly this many; effect: cap
--     allowLoops  = true,            -- music only
--     frequencyOffset = 0,           -- effect only (cry pitch / sfx pitch)
--     frameTicks  = 256,             -- effect only (0x80 + tempo)
--     cryLength   = 4,               -- cry only
--   }
--
-- Output is interleaved stereo s16 LE, the PCM layout of
-- contracts/spec/audio.ts. `music` renders through sampleStereo (the NR51
-- pan), `effect` through sample() duplicated to both channels — exactly the
-- split ChipSynth.lua:813 soundData and :843 renderEffectData make. The
-- frame count actually written is printed on stdout.
--
-- ChipSynth depends on `bit` (LuaJIT has it) and, for loadBanks, on
-- love.filesystem.read. Nothing else in the file is touched by this path, so
-- a two-function love stub is the whole harness: love.sound is only used by
-- soundData/renderEffectData, which this script deliberately does not call.

local root = assert(arg[1], "usage: luajit chipsynth-oracle.lua <root> <params> <out>")
local paramFile = assert(arg[2], "missing params file")
local outFile = assert(arg[3], "missing output file")
package.path = root .. "/?.lua;" .. root .. "/?/init.lua;" .. package.path

local params = assert(loadfile(paramFile))()

-- love.filesystem.read over the real filesystem: loadBanks asks for
-- data.audio.programFile, and we hand it an absolute path.
love = {
  filesystem = {
    read = function(path)
      local f = io.open(path, "rb")
      if not f then return nil, "no such file: " .. tostring(path) end
      local raw = f:read("*a")
      f:close()
      return raw
    end,
  },
}

local ChipSynth = require("src.core.ChipSynth")

local data = {
  audio = {
    programFile = params.programFile,
    bankOrder = params.bankOrder,
    waveBanks = params.waveBanks,
    noiseHeaders = params.noiseHeaders,
  },
}

local options = {}
if params.mode == "effect" then
  -- ChipSynth.lua:845-848 renderEffectData sets these two itself.
  options.sfx = true
  options.allowLoops = false
  options.frequencyOffset = params.frequencyOffset
  options.frameTicks = params.frameTicks
  options.cryLength = params.cryLength
else
  options.allowLoops = params.allowLoops ~= false
end

local engine = ChipSynth.newEngine(data, params.header, options)

-- The reference's host writes its -1..1 doubles into a 16-bit SoundData.
-- love scales by 32767 and rounds away from zero; the same rule is what the
-- Rust core's integer mix quantizes with, so this is the one shared
-- convention on top of ChipSynth itself.
local function toS16(value)
  local scaled = value * 32767
  local rounded
  if scaled >= 0 then rounded = math.floor(scaled + 0.5) else rounded = math.ceil(scaled - 0.5) end
  if rounded > 32767 then rounded = 32767 elseif rounded < -32768 then rounded = -32768 end
  return rounded
end

local function bytes(sample)
  if sample < 0 then sample = sample + 0x10000 end
  return string.char(sample % 256, math.floor(sample / 256))
end

local out = assert(io.open(outFile, "wb"))
local chunk, count = {}, 0
local written = 0
local function emit(left, right)
  chunk[#chunk + 1] = bytes(left)
  chunk[#chunk + 1] = bytes(right)
  count = count + 1
  written = written + 1
  if count >= 4096 then
    out:write(table.concat(chunk))
    chunk, count = {}, 0
  end
end

if params.mode == "effect" then
  -- ChipSynth.lua:849-856: at most five seconds, and it stops the moment the
  -- program is finished.
  local maximum = params.frames
  while written < maximum and not engine:finished() do
    local value = toS16(engine:sample())
    emit(value, value)
  end
else
  for _ = 1, params.frames do
    local left, right = engine:sampleStereo()
    emit(toS16(left), toS16(right))
  end
end

if count > 0 then out:write(table.concat(chunk)) end
out:close()
print(written)
