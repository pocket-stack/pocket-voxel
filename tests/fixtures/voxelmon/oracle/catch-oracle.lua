-- Catch micro-oracle: loads the REFERENCE gen1recomp Catching.lua (with its
-- Status dependency's non-pure requires stubbed) and prints `caught shakes`
-- for a fixed input matrix. tests/voxel-rules.test.ts runs the identical
-- matrix through the TS port and compares line-for-line. Invoked as:
--   luajit catch-oracle.lua <gen1recomp-root>

local root = assert(arg[1], "usage: luajit catch-oracle.lua <gen1recomp-root>")
package.path = root .. "/?.lua;" .. root .. "/?/init.lua;" .. package.path

package.preload["src.core.Strings"] = function()
  return setmetatable({ source = function(s) return s end },
    { __call = function(_, f, ...) return string.format(f, ...) end })
end
package.preload["src.core.RomText"] = function()
  return function(_, _, template, ...) return string.format(template or "", ...) end
end

local Catching = require("src.battle.Catching")

-- rolls injected the harness way (tests/harness.lua T.rng.seq): successive
-- calls walk the list, the last value repeats, min/max args are ignored
local function seq(...)
  local vals, i = { ... }, 0
  return function()
    i = i + 1
    return vals[math.min(i, #vals)]
  end
end

-- KEEP IN LOCKSTEP with the catch-oracle matrix in tests/voxel-rules.test.ts
local balls = { "MASTER_BALL", "POKE_BALL", "GREAT_BALL", "ULTRA_BALL" }
local statuses = { "NONE", "SLP", "PAR" }
local hps = { { 21, 21 }, { 5, 21 }, { 1, 21 }, { 150, 150 }, { 40, 150 } }
local rates = { 45, 200, 255 }
local rollPairs = { { 0, 0 }, { 25, 255 }, { 100, 0 }, { 149, 120 }, { 255, 255 } }

for _, ball in ipairs(balls) do
  for _, st in ipairs(statuses) do
    for _, hp in ipairs(hps) do
      for _, rate in ipairs(rates) do
        for _, pair in ipairs(rollPairs) do
          local targetMon = {
            hp = hp[1],
            status = st ~= "NONE" and st or nil,
            stats = { hp = hp[2] },
          }
          local targetDef = { catchRate = rate }
          local caught, shakes = Catching.attempt(ball, targetMon, targetDef,
            seq(pair[1], pair[2]))
          print(("%d %d"):format(caught and 1 or 0, shakes))
        end
      end
    end
  end
end
