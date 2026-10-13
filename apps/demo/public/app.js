// Live chaos demo — vanilla JS, no build step, no third-party code (strict CSP).
// State comes from the server over SSE: a full `snapshot`, then one `tick` per second.

const $ = (id) => document.getElementById(id)
const SVG_NS = 'http://www.w3.org/2000/svg'
const LOG_ROWS_MAX = 150
const BREAKER_THRESHOLD = 5

const state = {
  config: null,
  run: null, // { id, status, startedAt, elapsedMs, pushed, accepted, hook, samples[], attempts[] }
  lastTickAt: 0, // performance.now() of the last tick, to animate the clock between ticks
  cooldownUntil: 0,
  notice: null,
  hoverT: null,
}

// --- formatting -------------------------------------------------------------
const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const fmtT = (ms) => `+${(ms / 1000).toFixed(1)}s`
const shortId = (id) => `…${id.slice(-6).toLowerCase()}`
const statusClass = (code) => {
  if (code === null) return 'err'
  if (code < 400) return '2xx'
  if (code < 500) return '4xx'
  return '5xx'
}
function outcomeOf(a) {
  if (a.statusCode !== null && a.statusCode < 400) return ['delivered', 'delivered']
  if (a.statusCode !== null && a.statusCode < 500 && a.statusCode !== 429)
    return ['dead', 'dead · 4xx']
  return ['retry', a.errorClass === 'timeout' ? 'retry · timeout' : 'retry scheduled']
}

// --- elapsed / phase ----------------------------------------------------------
function elapsedNow() {
  const run = state.run
  if (!run) return 0
  if (run.status !== 'running') return run.elapsedMs
  return Math.min(
    run.elapsedMs + (performance.now() - state.lastTickAt),
    state.config.runDurationMs,
  )
}
function phaseAt(ms) {
  const phases = state.config.phases
  let found = phases[0]
  for (const p of phases) if (ms >= p.startMs) found = p
  return found
}

// --- timeline -----------------------------------------------------------------
function buildTimeline() {
  const { phases, runDurationMs, pushDurationMs } = state.config
  const track = $('timeline-track')
  track.replaceChildren(
    ...phases.map((p, i) => {
      const seg = document.createElement('div')
      seg.className = 'seg'
      seg.dataset.kind = p.kind
      seg.dataset.index = String(i)
      seg.style.flex = `${p.endMs - p.startMs} 0 0`
      seg.textContent = p.label
      seg.title = p.label
      return seg
    }),
  )
  $('timeline-push').style.width = `${(pushDurationMs / runDurationMs) * 100}%`
  $('clock-total').textContent = fmtClock(runDurationMs)
}

// --- render loop (clock, playhead, phase) --------------------------------------
function frame() {
  if (state.config) {
    const t = elapsedNow()
    const running = state.run?.status === 'running'
    $('clock').textContent = fmtClock(state.run ? t : 0)
    $('playhead').style.left = `${(t / state.config.runDurationMs) * 100}%`

    const phase = state.run ? phaseAt(t) : null
    const idx = phase ? state.config.phases.indexOf(phase) : -1
    for (const seg of document.querySelectorAll('.seg')) {
      seg.classList.toggle('is-active', running && Number(seg.dataset.index) === idx)
    }
    const chip = $('phase-chip')
    if (running && phase) {
      chip.textContent = phase.label
      chip.dataset.kind = phase.kind
      $('phase-desc').textContent = phase.description
    } else if (state.run?.status === 'finished') {
      chip.textContent = 'Finished'
      chip.dataset.kind = ''
      $('phase-desc').textContent = summary()
    }
    renderControls()
  }
  requestAnimationFrame(frame)
}

function summary() {
  const s = state.run?.samples.at(-1)
  if (!s) return ''
  const parts = [`${s.delivered} delivered`, `${s.dead} dead`]
  if (s.pending > 0) parts.push(`${s.pending} still waiting for a later retry`)
  return `Run complete: ${parts.join(', ')}, over ${s.attempts} HTTP attempts. ${s.skips} deliveries were postponed by the open breaker instead of hitting a dead endpoint.`
}

// --- controls -----------------------------------------------------------------
function renderControls() {
  const btn = $('run-btn')
  const label = $('run-btn-label')
  const status = $('status')
  const run = state.run
  const cooldownLeft = state.cooldownUntil - Date.now()
  document.body.dataset.run = run?.status ?? 'idle'

  if (run?.status === 'running') {
    btn.disabled = true
    label.textContent = 'Running…'
    setStatus(
      status,
      state.notice ??
        `<strong>Run in progress.</strong> ${run.pushed} / ${state.config.totalEvents} events pushed.`,
    )
  } else if (cooldownLeft > 0) {
    btn.disabled = true
    label.textContent = `Available in ${fmtClock(cooldownLeft)}`
    setStatus(status, 'One run per visitor every 3 minutes keeps the demo fair for everyone.')
  } else {
    btn.disabled = false
    label.textContent = run ? 'Run it again' : 'Run outage scenario'
    setStatus(
      status,
      run
        ? 'Last run shown below. Start a new one whenever you like.'
        : 'Ready. A run takes about 2 minutes.',
    )
  }
}
function setStatus(el, html) {
  if (el.dataset.html !== html) {
    el.innerHTML = html
    el.dataset.html = html
  }
}

async function startRun() {
  state.notice = null
  $('run-btn').disabled = true
  try {
    const res = await fetch('/api/runs', { method: 'POST' })
    if (res.status === 429) {
      const body = await res.json()
      state.cooldownUntil = Date.now() + (body.retry_after_ms ?? 60_000)
    } else if (res.status === 409) {
      state.notice = '<strong>Someone else just started a run</strong>, you are watching it live.'
    } else if (!res.ok) {
      state.notice = 'Could not start a run, please try again in a moment.'
    }
  } catch {
    state.notice = 'Network error, please try again.'
  }
}

// --- KPIs & receiver panel -----------------------------------------------------
function renderStats() {
  const run = state.run
  const s = run?.samples.at(-1)
  const total = state.config.totalEvents
  $('kpi-total').textContent = total
  $('kpi-delivered').textContent = s?.delivered ?? 0
  $('kpi-pending').textContent = s?.pending ?? 0
  $('kpi-dead').textContent = s?.dead ?? 0
  $('kpi-attempts').textContent = s?.attempts ?? 0
  $('kpi-skips').textContent = s?.skips ?? 0
  $('meter-delivered').style.width = `${((s?.delivered ?? 0) / total) * 100}%`

  const breaker = s?.breaker ?? 'closed'
  $('kpi-breaker').dataset.state = breaker
  $('kpi-breaker-state').textContent = breaker.replace('_', '-')
  let sub = `failure streak ${s?.failCount ?? 0} / ${BREAKER_THRESHOLD}`
  if (breaker === 'open' && s?.probeAt != null) {
    sub = `next probe in ${Math.max(0, Math.ceil((s.probeAt - s.t) / 1000))} s`
  } else if (breaker === 'half_open') {
    sub = 'letting one probe request through'
  }
  $('kpi-breaker-sub').textContent = sub

  $('rx-received').textContent = run?.hook.received ?? 0
  $('rx-verified').textContent = run?.hook.verified ?? 0
  $('rx-rejected').textContent = run?.hook.rejected ?? 0
  $('rx-accepted').textContent = run?.accepted ?? 0
  $('rx-pushed').textContent = run?.pushed ?? 0

  const counts = { '2xx': 0, '5xx': 0, '4xx': 0 }
  for (const a of run?.attempts ?? []) {
    const c = statusClass(a.statusCode)
    if (c === 'err') counts['5xx']++
    else counts[c]++
  }
  $('c-2xx').textContent = counts['2xx']
  $('c-5xx').textContent = counts['5xx']
  $('c-4xx').textContent = counts['4xx']
  const sum = counts['2xx'] + counts['5xx'] + counts['4xx'] || 1
  const bar = $('codes-bar')
  if (bar.children.length !== 3) {
    bar.replaceChildren(
      ...['sw-delivered', 'sw-fail', 'sw-dead'].map((c) =>
        Object.assign(document.createElement('span'), { className: c }),
      ),
    )
  }
  ;[counts['2xx'], counts['5xx'], counts['4xx']].forEach((n, i) => {
    bar.children[i].style.width = `${(n / sum) * 100}%`
  })
}

// --- attempt log ----------------------------------------------------------------
function logRow(a, isNew) {
  const tr = document.createElement('tr')
  if (isNew) tr.className = 'is-new'
  const [kind, text] = outcomeOf(a)
  const cls = statusClass(a.statusCode)
  const cells = [
    [fmtT(a.t), 'dim'],
    [shortId(a.eventId), ''],
    [`#${a.attempt}`, 'dim'],
    [null, ''],
    [String(a.durationMs), 'dim'],
    [text, `outcome-${kind}`],
  ]
  for (const [content, className] of cells) {
    const td = document.createElement('td')
    if (className) td.className = className
    if (content === null) {
      const pill = document.createElement('span')
      pill.className = `pill pill-${cls}`
      pill.textContent = a.statusCode ?? a.errorClass ?? 'error'
      td.append(pill)
    } else {
      td.textContent = content
    }
    tr.append(td)
  }
  tr.title = `${a.eventId} · attempt ${a.attempt}`
  return tr
}
function renderLog(fresh) {
  const body = $('log-body')
  if (!fresh) {
    const rows = (state.run?.attempts ?? []).slice(-LOG_ROWS_MAX).reverse()
    body.replaceChildren(...rows.map((a) => logRow(a, false)))
  } else {
    for (const a of fresh) body.prepend(logRow(a, true))
    while (body.children.length > LOG_ROWS_MAX) body.lastElementChild.remove()
  }
  $('log-empty').hidden = body.children.length > 0
}

// --- chart ------------------------------------------------------------------------
function el(name, attrs, parent) {
  const node = document.createElementNS(SVG_NS, name)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  if (parent) parent.append(node)
  return node
}

function renderChart() {
  const svg = $('chart')
  const W = svg.clientWidth || 1000
  const H = svg.clientHeight || 340
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.replaceChildren()

  const { phases, runDurationMs, totalEvents } = state.config
  const pad = { l: 38, r: 10, t: 8 }
  const laneH = 12
  const plotBottom = H - 62
  const laneY = plotBottom + 18
  const x = (ms) => pad.l + (Math.min(ms, runDurationMs) / runDurationMs) * (W - pad.l - pad.r)
  const y = (n) => plotBottom - (n / totalEvents) * (plotBottom - pad.t)

  for (const p of phases) {
    el(
      'rect',
      {
        class: `band-${p.kind}`,
        x: x(p.startMs),
        y: pad.t,
        width: x(p.endMs) - x(p.startMs),
        height: plotBottom - pad.t,
      },
      svg,
    )
  }
  for (let n = 0; n <= totalEvents; n += totalEvents / 4) {
    el('line', { class: 'grid', x1: pad.l, x2: W - pad.r, y1: y(n), y2: y(n) }, svg)
    el('text', { x: pad.l - 8, y: y(n) + 4, 'text-anchor': 'end' }, svg).textContent = n
  }
  const step = W < 600 ? 40_000 : 20_000
  for (let ms = 0; ms <= runDurationMs; ms += step) {
    el(
      'text',
      { x: x(ms), y: H - 8, 'text-anchor': ms === 0 ? 'start' : 'middle' },
      svg,
    ).textContent = `${ms / 1000}s`
  }

  el('text', { x: pad.l - 8, y: laneY + laneH - 2, 'text-anchor': 'end' }, svg).textContent = 'cb'
  el(
    'rect',
    { class: 'lane-bg', x: pad.l, y: laneY, width: W - pad.l - pad.r, height: laneH, rx: 3 },
    svg,
  )

  const samples = state.run?.samples ?? []
  $('chart-empty').hidden = samples.length > 0
  if (samples.length === 0) return

  // breaker lane: one rect per sample interval
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    const next = samples[i + 1]?.t ?? s.t + 1000
    const cls =
      s.breaker === 'open' ? 'lane-open' : s.breaker === 'half_open' ? 'lane-half' : 'lane-closed'
    el(
      'rect',
      {
        class: cls,
        x: x(s.t),
        y: laneY,
        width: Math.max(1, x(next) - x(s.t) + 0.5),
        height: laneH,
      },
      svg,
    )
  }

  const path = (key) =>
    samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join('')
  const last = samples.at(-1)
  el(
    'path',
    {
      class: 'area-delivered',
      d: `${path('delivered')}L${x(last.t)},${y(0)}L${x(samples[0].t)},${y(0)}Z`,
    },
    svg,
  )
  el('path', { class: 'line l-dead', d: path('dead') }, svg)
  el('path', { class: 'line l-pending', d: path('pending') }, svg)
  el('path', { class: 'line l-delivered', d: path('delivered') }, svg)

  if (state.run.status === 'running') {
    el('line', { class: 'now', x1: x(last.t), x2: x(last.t), y1: pad.t, y2: laneY + laneH }, svg)
  }

  if (state.hoverT !== null) {
    const s = nearestSample(state.hoverT)
    if (s) {
      el('line', { class: 'hover-line', x1: x(s.t), x2: x(s.t), y1: pad.t, y2: laneY + laneH }, svg)
      for (const key of ['delivered', 'pending', 'dead']) {
        el('circle', { cx: x(s.t), cy: y(s[key]), r: 3.5, class: `dot l-${key}` }, svg)
      }
      showTip(s, x(s.t), W)
    }
  }
  svg._geom = { pad, W, runDurationMs }
}

function nearestSample(t) {
  const samples = state.run?.samples ?? []
  let best = null
  for (const s of samples) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s
  return best
}

function showTip(s, px, W) {
  const tip = $('chart-tip')
  const phase = phaseAt(s.t)
  tip.innerHTML = `
    <div class="t">t = ${(s.t / 1000).toFixed(0)}s · ${phase.label}</div>
    <div class="row"><span>delivered</span><b class="c-delivered">${s.delivered}</b></div>
    <div class="row"><span>pending</span><b class="c-pending">${s.pending}</b></div>
    <div class="row"><span>dead</span><b class="c-dead">${s.dead}</b></div>
    <div class="row"><span>breaker</span><b>${s.breaker.replace('_', '-')}</b></div>`
  tip.hidden = false
  const left = px + 16 + 170 > W ? px - 16 - tip.offsetWidth : px + 16
  tip.style.left = `${left + 12}px`
  tip.style.top = '16px'
}

function bindChartHover() {
  const svg = $('chart')
  svg.addEventListener('pointermove', (e) => {
    const g = svg._geom
    if (!g) return
    const rect = svg.getBoundingClientRect()
    const px = e.clientX - rect.left
    state.hoverT = ((px - g.pad.l) / (g.W - g.pad.l - g.pad.r)) * g.runDurationMs
    renderChart()
  })
  svg.addEventListener('pointerleave', () => {
    state.hoverT = null
    $('chart-tip').hidden = true
    renderChart()
  })
}

// --- data flow ----------------------------------------------------------------------
function applySnapshot(run) {
  state.run = run
  state.lastTickAt = performance.now()
  if (run?.status !== 'running') state.notice = null
  renderAll()
}

function applyTick(msg) {
  const run = state.run
  if (!run || run.id !== msg.runId) {
    // A run we don't know yet (started elsewhere, or we missed the snapshot): resync.
    fetch('/api/state')
      .then((r) => r.json())
      .then((s) => applySnapshot(s.run))
      .catch(() => {})
    return
  }
  run.status = msg.status
  run.elapsedMs = msg.elapsedMs
  run.pushed = msg.pushed
  run.accepted = msg.accepted
  run.hook = msg.hook
  run.samples.push(msg.sample)
  run.attempts.push(...msg.attempts)
  state.lastTickAt = performance.now()
  if (msg.status !== 'running') state.notice = null
  renderStats()
  renderLog(msg.attempts)
  renderChart()
}

function renderAll() {
  renderStats()
  renderLog(null)
  renderChart()
}

function connect() {
  const source = new EventSource('/api/stream')
  source.addEventListener('snapshot', (e) => applySnapshot(JSON.parse(e.data).run))
  source.addEventListener('tick', (e) => applyTick(JSON.parse(e.data)))
  source.addEventListener('error', () => {
    setStatus($('status'), 'Connection lost, reconnecting…')
  })
}

async function main() {
  state.config = await fetch('/api/config').then((r) => r.json())
  for (const a of document.querySelectorAll('[data-src]')) {
    a.href = `${state.config.repoUrl}/blob/main/${a.dataset.src}`
    a.rel = 'noopener'
  }
  $('repo-link').href = state.config.repoUrl
  $('footer-repo').href = state.config.repoUrl
  buildTimeline()
  bindChartHover()
  $('run-btn').addEventListener('click', startRun)
  new ResizeObserver(() => renderChart()).observe($('chart'))
  renderAll()
  connect()
  requestAnimationFrame(frame)
}

main()
