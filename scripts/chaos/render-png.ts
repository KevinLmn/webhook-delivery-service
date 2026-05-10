import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { ChartConfiguration, ChartType } from 'chart.js'
import type { Sample } from './collector'

interface PhaseAnnotation {
  startMs: number
  endMs: number
  label: string
  fillColor: string
}

const BREAKER_NUMERIC: Record<Sample['breakerState'], number> = {
  closed: 0,
  half_open: 1,
  open: 2,
  unknown: 0
}

export interface RenderInput {
  samples: Sample[]
  phases: PhaseAnnotation[]
  totalEvents: number
  outDir: string
  /** Préfixe nom de fichier, ex 2026-05-10-14-32 */
  fileStem: string
}

/**
 * `chartjs-node-canvas@4.1.6` declares peer `chart.js@^3.5.1` and assumes the
 * v3 root export shape (`require('chart.js')` returns the `Chart` class with
 * a static `register`). Chart.js v4 instead exports a namespace object — so
 * the library throws `chartJs.register is not a function` on init. We shim
 * `require.cache` so any internal `require('chart.js')` resolves to
 * `chart.js/auto`, whose CJS module IS the auto-registered Chart class.
 */
function installChartJsV4Shim(): void {
  const req = createRequire(import.meta.url)
  const chartJsResolved = req.resolve('chart.js')
  if (req.cache[chartJsResolved]) return // already shimmed
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ChartAuto = req('chart.js/auto') as unknown
  // Build a Module-like cache entry. We use a minimal duck-typed object here
  // because `module.Module` typing is awkward across Node versions.
  req.cache[chartJsResolved] = {
    id: chartJsResolved,
    filename: chartJsResolved,
    loaded: true,
    exports: ChartAuto,
    children: [],
    paths: []
  } as unknown as NodeJS.Require['cache'][string]
}

export async function renderChaosPng(input: RenderInput): Promise<string> {
  await mkdir(input.outDir, { recursive: true })
  const outPath = path.join(input.outDir, `${input.fileStem}.png`)

  installChartJsV4Shim()
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas')

  const labels = input.samples.map((s) => (s.tMs / 1000).toFixed(0))
  const delivered = input.samples.map((s) => s.delivered)
  const pending = input.samples.map((s) => s.pending)
  const dead = input.samples.map((s) => s.dead)
  const breaker = input.samples.map((s) => BREAKER_NUMERIC[s.breakerState])

  // chart.js plugin "annotation" est dans le namespace officiel mais pas inclus
  // par défaut. Pour rester sans dépendance supplémentaire, on bake les bandes
  // de phase via un dataset de type "bar" semi-transparent en arrière-plan.

  const phaseBars = input.phases.map((p) => {
    const arr = labels.map((l) => {
      const t = Number(l) * 1000
      return t >= p.startMs && t < p.endMs ? Math.max(input.totalEvents, 1) : null
    })
    return {
      type: 'bar' as const,
      label: p.label,
      data: arr,
      backgroundColor: p.fillColor,
      borderWidth: 0,
      stack: 'phase',
      yAxisID: 'y',
      barPercentage: 1.0,
      categoryPercentage: 1.0,
      order: 99
    }
  })

  const config: ChartConfiguration<ChartType> = {
    type: 'line',
    data: {
      labels,
      datasets: [
        ...phaseBars,
        {
          type: 'line',
          label: 'delivered',
          data: delivered,
          borderColor: '#16a34a',
          backgroundColor: '#16a34a',
          tension: 0.1,
          yAxisID: 'y',
          order: 1
        },
        {
          type: 'line',
          label: 'pending',
          data: pending,
          borderColor: '#f59e0b',
          backgroundColor: '#f59e0b',
          tension: 0.1,
          yAxisID: 'y',
          order: 2
        },
        {
          type: 'line',
          label: 'dead',
          data: dead,
          borderColor: '#dc2626',
          backgroundColor: '#dc2626',
          tension: 0.1,
          yAxisID: 'y',
          order: 3
        },
        {
          type: 'line',
          label: 'breaker (0=closed,1=half_open,2=open)',
          data: breaker,
          borderColor: '#2563eb',
          backgroundColor: '#2563eb',
          stepped: 'before',
          yAxisID: 'y2',
          order: 4
        }
      ]
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        title: {
          display: true,
          text: `Chaos demo — ${input.totalEvents} events, ${labels.length}s sampling`
        },
        legend: { position: 'bottom' }
      },
      scales: {
        x: { title: { display: true, text: 'time (s)' } },
        y: {
          title: { display: true, text: 'events count' },
          beginAtZero: true
        },
        y2: {
          position: 'right',
          title: { display: true, text: 'breaker state' },
          min: 0,
          max: 2,
          ticks: { stepSize: 1 },
          grid: { drawOnChartArea: false }
        }
      }
    }
  }

  const chart = new ChartJSNodeCanvas({
    width: 1200,
    height: 600,
    backgroundColour: 'white'
  })
  const buffer = await chart.renderToBuffer(config, 'image/png')
  await writeFile(outPath, buffer)
  return outPath
}
