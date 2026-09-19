-- Minimal JSON decoder/encoder.
--
-- Decoding: objects become plain tables whose key order is remembered (so a
-- decoded object re-encodes in its original order), arrays get the ARRAY
-- metatable (so empty arrays and arrays containing null survive), and null
-- decodes to the `M.null` sentinel. Numbers without '.', 'e' or 'E' decode as
-- Lua integers, everything else as floats.
--
-- Encoding mirrors Go's encoding/json: floats use the shortest round-trip
-- representation in plain decimal notation (exponent form only below 1e-6 or
-- at/above 1e21), integral floats print without a fraction, HTML-sensitive
-- characters are escaped, and objects without a recorded order are written
-- with sorted keys (like Go maps).

local M = {}

local null = setmetatable({}, { __name = "json.null", __tostring = function() return "null" end })
M.null = null

local ARRAY = { __name = "json.array" }
M.ARRAY = ARRAY

-- key order of objects (weak keys so decoded tables can be collected)
local order = setmetatable({}, { __mode = "k" })

--- Build an array (marks the table so it encodes as [] even when empty).
function M.array(t)
  return setmetatable(t or {}, ARRAY)
end

--- Build an ordered object from a flat list {k1, v1, k2, v2, ...}.
--- Pairs whose value is nil are skipped (use M.null for an explicit null).
function M.obj(list)
  local t, keys = {}, {}
  local n = list.n or #list
  for i = 1, n, 2 do
    local k, v = list[i], list[i + 1]
    if v ~= nil then
      if t[k] == nil then keys[#keys + 1] = k end
      t[k] = v
    end
  end
  order[t] = keys
  return t
end

--- Set a key on an ordered object, appending it to the order if new.
function M.set(t, k, v)
  local keys = order[t]
  if not keys then
    keys = {}
    order[t] = keys
  end
  if t[k] == nil then keys[#keys + 1] = k end
  t[k] = v
end

--- Ordered keys of a decoded/constructed object (nil if unknown).
function M.keys(t)
  return order[t]
end

function M.is_array(t)
  return getmetatable(t) == ARRAY
end

---------------------------------------------------------------------------
-- decoder

local byte, sub, find, char = string.byte, string.sub, string.find, string.char

local function decode_error(str, pos, msg)
  local line = 1
  for _ in sub(str, 1, pos):gmatch("\n") do line = line + 1 end
  error(string.format("json: %s at line %d (byte %d)", msg, line, pos), 0)
end

local function skip_ws(str, pos)
  local _, e = find(str, "^[ \t\r\n]*", pos)
  return e + 1
end

local function utf8_char(cp)
  return utf8.char(cp)
end

local escapes = { ['"'] = '"', ["\\"] = "\\", ["/"] = "/", b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" }

local function parse_string(str, pos)
  -- pos points at the opening quote
  local buf = {}
  local i = pos + 1
  while true do
    local s, e = find(str, '^[^"\\]+', i)
    if s then
      buf[#buf + 1] = sub(str, s, e)
      i = e + 1
    end
    local c = sub(str, i, i)
    if c == '"' then
      return table.concat(buf), i + 1
    elseif c == "\\" then
      local n = sub(str, i + 1, i + 1)
      if n == "u" then
        local hex = sub(str, i + 2, i + 5)
        local cp = tonumber(hex, 16)
        if not cp or #hex ~= 4 then decode_error(str, i, "bad \\u escape") end
        i = i + 6
        if cp >= 0xD800 and cp <= 0xDBFF and sub(str, i, i + 1) == "\\u" then
          local lo = tonumber(sub(str, i + 2, i + 5), 16)
          if lo and lo >= 0xDC00 and lo <= 0xDFFF then
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00)
            i = i + 6
          end
        end
        buf[#buf + 1] = utf8_char(cp)
      else
        local r = escapes[n]
        if not r then decode_error(str, i, "bad escape") end
        buf[#buf + 1] = r
        i = i + 2
      end
    else
      decode_error(str, i, "unterminated string")
    end
  end
end

local parse_value

local function parse_number(str, pos)
  local s, e = find(str, "^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
  if not s then decode_error(str, pos, "bad number") end
  local text = sub(str, s, e)
  local v
  if find(text, "[.eE]") then
    v = tonumber(text)
    if v then v = v + 0.0 end
  else
    v = math.tointeger(tonumber(text))
    if v == nil then v = tonumber(text) + 0.0 end -- beyond int64: keep as float
  end
  if v == nil then decode_error(str, pos, "bad number") end
  return v, e + 1
end

local function parse_array(str, pos)
  local arr = setmetatable({}, ARRAY)
  local n = 0
  pos = skip_ws(str, pos + 1)
  if sub(str, pos, pos) == "]" then return arr, pos + 1 end
  while true do
    local v
    v, pos = parse_value(str, pos)
    n = n + 1
    arr[n] = v
    pos = skip_ws(str, pos)
    local c = sub(str, pos, pos)
    if c == "]" then return arr, pos + 1 end
    if c ~= "," then decode_error(str, pos, "expected ',' or ']'") end
    pos = skip_ws(str, pos + 1)
  end
end

local function parse_object(str, pos)
  local obj, keys = {}, {}
  order[obj] = keys
  pos = skip_ws(str, pos + 1)
  if sub(str, pos, pos) == "}" then return obj, pos + 1 end
  while true do
    if sub(str, pos, pos) ~= '"' then decode_error(str, pos, "expected string key") end
    local k
    k, pos = parse_string(str, pos)
    pos = skip_ws(str, pos)
    if sub(str, pos, pos) ~= ":" then decode_error(str, pos, "expected ':'") end
    pos = skip_ws(str, pos + 1)
    local v
    v, pos = parse_value(str, pos)
    if obj[k] == nil then keys[#keys + 1] = k end
    obj[k] = v
    pos = skip_ws(str, pos)
    local c = sub(str, pos, pos)
    if c == "}" then return obj, pos + 1 end
    if c ~= "," then decode_error(str, pos, "expected ',' or '}'") end
    pos = skip_ws(str, pos + 1)
  end
end

parse_value = function(str, pos)
  local c = sub(str, pos, pos)
  if c == "{" then
    return parse_object(str, pos)
  elseif c == "[" then
    return parse_array(str, pos)
  elseif c == '"' then
    return parse_string(str, pos)
  elseif c == "t" and sub(str, pos, pos + 3) == "true" then
    return true, pos + 4
  elseif c == "f" and sub(str, pos, pos + 4) == "false" then
    return false, pos + 5
  elseif c == "n" and sub(str, pos, pos + 3) == "null" then
    return null, pos + 4
  elseif c == "-" or (c >= "0" and c <= "9" and c ~= "") then
    return parse_number(str, pos)
  end
  decode_error(str, pos, "unexpected character '" .. c .. "'")
end

--- Decode a JSON text. Raises an error string on malformed input.
function M.decode(str)
  local pos = skip_ws(str, 1)
  local v
  v, pos = parse_value(str, pos)
  pos = skip_ws(str, pos)
  if pos <= #str then decode_error(str, pos, "trailing data") end
  return v
end

--- Read and decode a file. Returns value or nil, err.
function M.read_file(path)
  local f, err = io.open(path, "rb")
  if not f then return nil, err end
  local data = f:read("a")
  f:close()
  local ok, v = pcall(M.decode, data)
  if not ok then return nil, path .. ": " .. tostring(v) end
  return v
end

---------------------------------------------------------------------------
-- encoder

local fmt = string.format
local mtype = math.type

--- Format a float like Go's strconv.FormatFloat(f, 'f' or 'e', -1, 64) as
--- used by encoding/json.
local function format_float(f)
  if f ~= f or f == math.huge or f == -math.huge then
    error("json: unsupported float value " .. tostring(f))
  end
  if f == 0 then
    if 1 / f < 0 then return "-0" end
    return "0"
  end
  -- shortest precision that round-trips
  local s
  for p = 1, 17 do
    s = fmt("%." .. (p - 1) .. "e", f)
    if tonumber(s) == f then break end
  end
  local neg = ""
  if sub(s, 1, 1) == "-" then
    neg = "-"
    s = sub(s, 2)
  end
  local mant, ex = s:match("^([%d%.]+)e([-+]%d+)$")
  local digits = mant:gsub("%.", "")
  digits = digits:gsub("0+$", "")
  if digits == "" then digits = "0" end
  local e = tonumber(ex)
  local a = math.abs(f)
  if a < 1e-6 or a >= 1e21 then
    local m = sub(digits, 1, 1)
    if #digits > 1 then m = m .. "." .. sub(digits, 2) end
    local es
    if e < 0 then
      es = "e-" .. tostring(-e)
    else
      es = fmt("e+%02d", e)
    end
    return neg .. m .. es
  end
  local out
  if e >= 0 then
    if #digits <= e + 1 then
      out = digits .. string.rep("0", e + 1 - #digits)
    else
      out = sub(digits, 1, e + 1) .. "." .. sub(digits, e + 2)
    end
  else
    out = "0." .. string.rep("0", -e - 1) .. digits
  end
  return neg .. out
end
M.format_float = format_float

local escape_map = {
  ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t",
  ["<"] = "\\u003c", [">"] = "\\u003e", ["&"] = "\\u0026",
}

local function escape_str(s)
  s = s:gsub('[%c"\\<>&]', function(c)
    local r = escape_map[c]
    if r then return r end
    return fmt("\\u%04x", byte(c))
  end)
  s = s:gsub("\226\128\168", "\\u2028"):gsub("\226\128\169", "\\u2029")
  return '"' .. s .. '"'
end

local function sorted_keys(t)
  local keys = {}
  for k in pairs(t) do keys[#keys + 1] = k end
  table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
  return keys
end

local encode_value

local function encode_table(t, buf, indent, cur)
  local nl, inner
  if indent then
    inner = cur .. indent
    nl = "\n"
  end
  if getmetatable(t) == ARRAY then
    local n = #t
    if n == 0 then
      buf[#buf + 1] = "[]"
      return
    end
    buf[#buf + 1] = "["
    for i = 1, n do
      if i > 1 then buf[#buf + 1] = "," end
      if indent then buf[#buf + 1] = nl .. inner end
      encode_value(t[i], buf, indent, inner)
    end
    if indent then buf[#buf + 1] = nl .. cur end
    buf[#buf + 1] = "]"
    return
  end
  local keys = order[t] or sorted_keys(t)
  local first = true
  buf[#buf + 1] = "{"
  for _, k in ipairs(keys) do
    local v = t[k]
    if v ~= nil then
      if not first then buf[#buf + 1] = "," end
      first = false
      if indent then buf[#buf + 1] = nl .. inner end
      buf[#buf + 1] = escape_str(tostring(k))
      buf[#buf + 1] = indent and ": " or ":"
      encode_value(v, buf, indent, inner)
    end
  end
  if not first and indent then buf[#buf + 1] = nl .. cur end
  buf[#buf + 1] = "}"
end

encode_value = function(v, buf, indent, cur)
  local tv = type(v)
  if v == null or v == nil then
    buf[#buf + 1] = "null"
  elseif tv == "boolean" then
    buf[#buf + 1] = v and "true" or "false"
  elseif tv == "number" then
    if mtype(v) == "integer" then
      buf[#buf + 1] = fmt("%d", v)
    else
      buf[#buf + 1] = format_float(v)
    end
  elseif tv == "string" then
    buf[#buf + 1] = escape_str(v)
  elseif tv == "table" then
    encode_table(v, buf, indent, cur)
  else
    error("json: cannot encode " .. tv)
  end
end

--- Encode a value. `indent` (e.g. "  ") enables Go MarshalIndent-style output.
function M.encode(v, indent)
  local buf = {}
  encode_value(v, buf, indent, "")
  return table.concat(buf)
end

return M
