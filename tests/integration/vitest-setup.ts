import { setRetryScheduleOverride } from '@vitrine/core'
import { setBreakerConfigOverride } from '@vitrine/queue'
import { afterAll } from 'vitest'

// Runs in each test process (vitest setupFiles), unlike `setup.ts` which is a
// `globalSetup` and executes in the main vitest process. The override state is
// module-local, so it must be applied here to take effect for the worker/queue
// code under test.
setRetryScheduleOverride([0, 50, 100, 200, 400, 800, 1600])
setBreakerConfigOverride({ initialOpenMs: 1_000, maxOpenMs: 5_000 })

afterAll(() => {
  setRetryScheduleOverride(null)
  setBreakerConfigOverride(null)
})
