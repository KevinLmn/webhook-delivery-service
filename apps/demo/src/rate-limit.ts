// ============================================================================
//  rate-limit.ts — "One run per IP every N ms", in memory.
//  Good enough for a single-instance demo; a multi-instance setup would keep
//  this in Redis (SET key NX PX).
// ============================================================================

export class CooldownLimiter {
  private readonly lastHit = new Map<string, number>()

  constructor(private readonly cooldownMs: number) {}

  /** Returns 0 if allowed (and records the hit), otherwise the remaining wait in ms */
  tryAcquire(key: string, now: number): number {
    const last = this.lastHit.get(key)
    if (last !== undefined && now - last < this.cooldownMs) {
      return this.cooldownMs - (now - last)
    }
    this.lastHit.set(key, now)
    this.prune(now)
    return 0
  }

  private prune(now: number): void {
    if (this.lastHit.size < 10_000) return
    for (const [key, at] of this.lastHit) {
      if (now - at >= this.cooldownMs) this.lastHit.delete(key)
    }
  }
}
