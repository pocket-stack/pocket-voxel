-- Damage micro-oracle: loads the REFERENCE gen1recomp Damage.lua (with its
-- non-pure requires stubbed) and prints `damage typeMult missed` for a fixed
-- input matrix. tests/voxel-rules.test.ts runs the identical matrix through
-- the TS port and compares line-for-line. Invoked as:
--   luajit damage-oracle.lua <gen1recomp-root>

local root = assert(arg[1], "usage: luajit damage-oracle.lua <gen1recomp-root>")
package.path = root .. "/?.lua;" .. root .. "/?/init.lua;" .. package.path

package.preload["src.core.Logger"] = function()
  local noop = function() end
  return { warn = noop, info = noop, error = noop, debug = noop }
end
package.preload["src.mods.Runtime"] = function()
  return {
    wantsHook = function() return false end,
    wants = function() return false end,
    call = function(_, fn, ...) return fn(...) end,
    emit = function() end,
  }
end
package.preload["src.core.Strings"] = function()
  return setmetatable({ source = function(s) return s end },
    { __call = function(_, f, ...) return string.format(f, ...) end })
end
package.preload["src.core.RomText"] = function()
  return function(_, _, template, ...) return string.format(template or "", ...) end
end

local Damage = require("src.battle.Damage")
local TypeChart = require("src.battle.TypeChart")
local rules = require("src.battle.rulesets.gen1_faithful")

-- the fixture triangle (tests/fixture_data/type_chart.lua)
TypeChart.load({ type_chart = { matchups = {
  { attacker = "FIRE", defender = "GRASS", multiplier = 20 },
  { attacker = "GRASS", defender = "WATER", multiplier = 20 },
  { attacker = "WATER", defender = "FIRE", multiplier = 20 },
  { attacker = "FIRE", defender = "WATER", multiplier = 5 },
  { attacker = "WATER", defender = "GRASS", multiplier = 5 },
  { attacker = "GRASS", defender = "FIRE", multiplier = 5 },
} } })

-- KEEP IN LOCKSTEP with the damage-oracle matrix in tests/voxel-rules.test.ts
local levels = { 5, 20, 50, 100 }
local powers = { 40, 90, 120 }
local statPairs = { { 30, 30 }, { 120, 80 }, { 300, 120 }, { 45, 300 } }
local rolls = { 217, 234, 255 }
local matchups = {
  { moveType = "NORMAL", defTypes = { "GRASS" } },          -- neutral + STAB
  { moveType = "FIRE", defTypes = { "GRASS" } },            -- 2x
  { moveType = "FIRE", defTypes = { "WATER" } },            -- 0.5x
  { moveType = "FIRE", defTypes = { "GRASS", "WATER" } },   -- 2x then 0.5x rows
}

for _, crit in ipairs({ false, true }) do
  for _, mu in ipairs(matchups) do
    for _, sp in ipairs(statPairs) do
      for _, power in ipairs(powers) do
        for _, level in ipairs(levels) do
          for _, roll in ipairs(rolls) do
            local attacker = {
              mon = { level = level },
              def = { baseStats = { speed = 45 } },
              curStats = { attack = sp[1], defense = 10, speed = 10, special = sp[1] },
              curTypes = { "NORMAL" },
              stages = {},
            }
            local defender = {
              mon = { level = level },
              def = { baseStats = { speed = 45 } },
              curStats = { attack = 10, defense = sp[2], speed = 10, special = sp[2] },
              curTypes = mu.defTypes,
              stages = {},
            }
            local move = { id = "ORACLE_MOVE", type = mu.moveType, power = power, accuracy = 100 }
            local dmg, info = Damage.compute(rules, attacker, defender, move, {
              rng = function() return roll end,
              forceCrit = crit,
            })
            print(("%d %d %d"):format(dmg, info.typeMult, info.missed and 1 or 0))
          end
        end
      end
    end
  end
end
