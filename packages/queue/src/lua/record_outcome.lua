-- ============================================================================
--  record_outcome.lua — The CIRCUIT BREAKER, the version that ACTUALLY runs.
--
--  ⭐ WHY LUA? The breaker is SHARED between 10 concurrent workers
--  (and several processes). "Read state → decide → write back" must be
--  ATOMIC, otherwise two workers step on each other (race condition). A Lua
--  script runs ATOMICALLY inside Redis: nothing interleaves during its
--  execution. This is THE most subtle technical point of the project.
--  (fsm.ts is the same logic as a pure/testable version; THIS is the real one.)
-- ============================================================================

-- KEYS[1] : breaker:{endpoint_id}   (the Redis key of THIS breaker)
-- ARGV[1] : event ('success' | 'failure' | 'read')
-- ARGV[2] : nowMs
-- ARGV[3] : initialOpenMs (30000)   -- initial cooldown: 30s
-- ARGV[4] : maxOpenMs (1800000)     -- cooldown cap: 30 min
-- ARGV[5] : failThreshold (5)       -- 5 failures → open
-- ARGV[6] : ttlSec (86400)          -- state expires after 24h of inactivity
-- Returns: the state encoded as JSON

-- 1) Read the current state. If it doesn't exist yet → default state "closed".
local raw = redis.call('GET', KEYS[1])
local state
if raw then
  state = cjson.decode(raw)
else
  state = { state = 'closed', openedAt = cjson.null, failCount = 0, openDurationMs = tonumber(ARGV[3]) }
end

local event = ARGV[1]
-- The clock comes from the caller, not from Redis TIME: tests can inject any
-- instant, at the price of trusting worker clocks to agree (NTP) within the
-- precision we care about (seconds, against a 30 s cooldown).
local now = tonumber(ARGV[2])
local initial = tonumber(ARGV[3])
local cap = tonumber(ARGV[4])
local threshold = tonumber(ARGV[5])
local ttl = tonumber(ARGV[6])

-- 2) Lazy open -> half_open transition: if the cooldown has elapsed, switch
--    to "probe" BEFORE applying the event. (Nobody "wakes up" the breaker:
--    the next read is what notices that the time has passed.)
--    Unlike fsm.ts, this runs for EVERY event, not only 'read': a 'failure'
--    that lands after the cooldown is treated as a failed probe (reopen, doubled).
if state.state == 'open' and state.openedAt and (state.openedAt + state.openDurationMs) <= now then
  state.state = 'half_open'
  state.openedAt = cjson.null
end

-- 3) The state machine (same rules as fsm.ts):
if state.state == 'closed' then
  if event == 'success' then
    state.failCount = 0                 -- a success resets the counter
  elseif event == 'failure' then
    state.failCount = state.failCount + 1
    if state.failCount >= threshold then
      state.state = 'open'              -- 5th failure → OPEN
      state.openedAt = now
      state.failCount = 0                -- unused while open; the next close counts from 0 again
      state.openDurationMs = initial
    end
  end
elseif state.state == 'open' then
  -- A 'failure' here is deliberately a no-op: it comes from a request that was
  -- already in flight when the breaker opened, and must not extend the cooldown.
  if event == 'success' then
    -- Defensive: a success while "open" shouldn't happen, but close cleanly anyway.
    state.state = 'closed'
    state.openedAt = cjson.null
    state.failCount = 0
    state.openDurationMs = initial
  end
elseif state.state == 'half_open' then
  if event == 'success' then
    state.state = 'closed'             -- probe succeeds → HEALED, close
    state.openedAt = cjson.null
    state.failCount = 0
    state.openDurationMs = initial
  elseif event == 'failure' then
    state.state = 'open'               -- probe fails → REOPEN
    state.openedAt = now
    state.failCount = 0
    state.openDurationMs = math.min(state.openDurationMs * 2, cap) -- cooldown DOUBLED (max 30 min)
  end
end

-- 4) Write the state back (with 24h TTL) and return it to the Node code.
--    Even a 'read' writes: the lazy open -> half_open flip must be persisted so
--    every worker sees the same state, and the TTL slides so only endpoints
--    that went quiet for 24h lose their history.
local encoded = cjson.encode(state)
redis.call('SET', KEYS[1], encoded, 'EX', ttl)
return encoded
