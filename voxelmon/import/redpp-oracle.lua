-- LuaJIT one-shot: the RED++ color ORACLE.
--
-- Loads gen1recomp's own `src.render.PaletteFX` — the executable spec for
-- ADVANCED (`redpp`) colorization — and dumps, for every map named on the
-- command line, the 4 resolved colors of every tile-graphic id 0..95.
-- `tests/voxel-cook.test.ts` deep-compares that against what
-- `apps/voxelmon/cook/redpp.ts` bakes, so the group assignment AND the
-- roof-slot swap are checked against the reference itself rather than
-- against a transcription of it.
--
-- `worldGroupAt`/`worldGroupColors` are pure Lua (their only require is
-- `src.core.GameVersion`, which declares itself dependency-free so it
-- "loads under plain Lua for tools") — no `love`, no graphics stack.
--
--   luajit apps/voxelmon/import/redpp-oracle.lua <g1r-root> \
--       <MAP_ID>:<TILESET>:<mapIndex> ...
--
-- Prints one JSON object on stdout:
--   { "<MAP_ID>": { "tileset": "...", "index": N,
--                   "tiles": [ [[r,g,b] x 4] x 96 ] } }

local root = assert(arg[1], "usage: luajit redpp-oracle.lua <g1r-root> <MAP:TILESET:INDEX>...")
package.path = root .. "/?.lua;" .. root .. "/?/init.lua;" .. package.path

local PaletteFX = require("src.render.PaletteFX")

-- worldGroupColors' only use of `data` is `data.maps[mapId].index` for the
-- roof lookup, so a stub carrying exactly that is a faithful stand-in.
local maps, order = {}, {}
for i = 2, #arg do
  local id, tileset, index = arg[i]:match("^([^:]+):([^:]+):(%-?%d+)$")
  assert(id, "bad map spec: " .. arg[i])
  maps[id] = { index = tonumber(index) }
  order[#order + 1] = { id = id, tileset = tileset }
end
local data = { maps = maps }

local out = {}
local function put(s) out[#out + 1] = s end

put("{")
for i, m in ipairs(order) do
  if i > 1 then put(",") end
  put(string.format('"%s":{"tileset":"%s","index":%d,"tiles":[', m.id, m.tileset, maps[m.id].index))
  local groups = PaletteFX.worldGroupColors(data, m.tileset, m.id, nil)
  assert(groups, "no groupColors for tileset " .. m.tileset)
  for tile = 0, 95 do
    if tile > 0 then put(",") end
    local group = PaletteFX.worldGroupAt(m.tileset, m.id, tile)
    assert(group, "no group for " .. m.tileset .. " tile " .. tile)
    -- Lua's group array is 1-based; group 0 is groups[1].
    local colors = groups[group + 1]
    put("[")
    for shade = 1, 4 do
      if shade > 1 then put(",") end
      local c = colors[shade]
      put(string.format("[%d,%d,%d]", c[1], c[2], c[3]))
    end
    put("]")
  end
  put("]}")
end
put("}")

io.write(table.concat(out))
io.write("\n")
