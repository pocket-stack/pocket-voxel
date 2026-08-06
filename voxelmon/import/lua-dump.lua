-- LuaJIT one-shot: execute a `return <table>` reference module from
-- $VOXELMON_G1R/data/generated/ and print it as JSON on stdout, applying the
-- apps/voxelmon/SCHEMA.md normalization: dense 1..n numeric-keyed tables
-- become JSON arrays, everything else becomes an object (numeric keys
-- stringified); empty tables print as {} (the parity comparator treats empty
-- {} and [] as equal).
--
--   luajit apps/voxelmon/import/lua-dump.lua <file.lua>

local path = assert(arg[1], "usage: luajit lua-dump.lua <file.lua>")
local chunk = assert(loadfile(path))
local value = chunk()

local out = {}

local function escape(s)
  s = s:gsub('[%z\1-\31\\"]', function(c)
    if c == "\\" then return "\\\\" end
    if c == '"' then return '\\"' end
    if c == "\n" then return "\\n" end
    if c == "\r" then return "\\r" end
    if c == "\t" then return "\\t" end
    if c == "\f" then return "\\f" end
    if c == "\b" then return "\\b" end
    return string.format("\\u%04X", c:byte())
  end)
  return '"' .. s .. '"'
end

-- same array test as gen1recomp LuaWriter.lua isArray: every key a positive
-- integer, count == maximum
local function isArray(t)
  local count, maximum = 0, 0
  for key in pairs(t) do
    if type(key) ~= "number" or key < 1 or key % 1 ~= 0 then
      return false, 0
    end
    count = count + 1
    if key > maximum then maximum = key end
  end
  return count == maximum, maximum
end

local function encodeNumber(v)
  if v % 1 == 0 then return string.format("%d", v) end
  return tostring(v)
end

local function encode(value)
  local kind = type(value)
  if kind == "number" then
    out[#out + 1] = encodeNumber(value)
  elseif kind == "string" then
    out[#out + 1] = escape(value)
  elseif kind == "boolean" then
    out[#out + 1] = tostring(value)
  elseif kind == "table" then
    local array, length = isArray(value)
    if array and length > 0 then
      out[#out + 1] = "["
      for index = 1, length do
        if index > 1 then out[#out + 1] = "," end
        encode(value[index])
      end
      out[#out + 1] = "]"
    else
      local keys = {}
      for key in pairs(value) do
        local text = type(key) == "number" and encodeNumber(key) or key
        keys[#keys + 1] = text
      end
      table.sort(keys)
      out[#out + 1] = "{"
      local originals = {}
      for key in pairs(value) do
        local text = type(key) == "number" and encodeNumber(key) or key
        originals[text] = key
      end
      for index, text in ipairs(keys) do
        if index > 1 then out[#out + 1] = "," end
        out[#out + 1] = escape(text)
        out[#out + 1] = ":"
        encode(value[originals[text]])
      end
      out[#out + 1] = "}"
    end
  else
    error("cannot serialize " .. kind)
  end
end

encode(value)
io.write(table.concat(out))
io.write("\n")
