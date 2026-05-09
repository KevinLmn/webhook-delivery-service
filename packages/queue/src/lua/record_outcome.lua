-- KEYS[1] : breaker:{endpoint_id}
-- ARGV[1] : event ('success' | 'failure' | 'read')
-- ARGV[2] : nowMs
-- ARGV[3] : initialOpenMs (30000)
-- ARGV[4] : maxOpenMs (1800000)
-- ARGV[5] : failThreshold (5)
-- ARGV[6] : ttlSec (86400)
-- Returns : encoded JSON state

local raw = redis.call('GET', KEYS[1])
local state
if raw then
  state = cjson.decode(raw)
else
  state = { state = 'closed', openedAt = cjson.null, failCount = 0, openDurationMs = tonumber(ARGV[3]) }
end

local event = ARGV[1]
local now = tonumber(ARGV[2])
local initial = tonumber(ARGV[3])
local cap = tonumber(ARGV[4])
local threshold = tonumber(ARGV[5])
local ttl = tonumber(ARGV[6])

-- Lazy transition open -> half_open on read
if state.state == 'open' and state.openedAt and (state.openedAt + state.openDurationMs) <= now then
  state.state = 'half_open'
  state.openedAt = cjson.null
end

if state.state == 'closed' then
  if event == 'success' then
    state.failCount = 0
  elseif event == 'failure' then
    state.failCount = state.failCount + 1
    if state.failCount >= threshold then
      state.state = 'open'
      state.openedAt = now
      state.failCount = 0
      state.openDurationMs = initial
    end
  end
elseif state.state == 'open' then
  if event == 'success' then
    state.state = 'closed'
    state.openedAt = cjson.null
    state.failCount = 0
    state.openDurationMs = initial
  end
elseif state.state == 'half_open' then
  if event == 'success' then
    state.state = 'closed'
    state.openedAt = cjson.null
    state.failCount = 0
    state.openDurationMs = initial
  elseif event == 'failure' then
    state.state = 'open'
    state.openedAt = now
    state.failCount = 0
    state.openDurationMs = math.min(state.openDurationMs * 2, cap)
  end
end

local encoded = cjson.encode(state)
redis.call('SET', KEYS[1], encoded, 'EX', ttl)
return encoded
