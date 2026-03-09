export class UiFlushScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending = false

  constructor(
    private readonly intervalMs: number,
    private readonly flush: () => void,
    private readonly setTimeoutFn: typeof setTimeout = setTimeout,
    private readonly clearTimeoutFn: typeof clearTimeout = clearTimeout,
  ) {}

  schedule() {
    if (this.pending) {
      return
    }

    this.pending = true
    this.timer = this.setTimeoutFn(() => {
      this.pending = false
      this.timer = null
      this.flush()
    }, this.intervalMs)
  }

  flushNow() {
    if (this.timer) {
      this.clearTimeoutFn(this.timer)
      this.timer = null
    }

    if (this.pending) {
      this.pending = false
      this.flush()
    }
  }

  cancel() {
    if (this.timer) {
      this.clearTimeoutFn(this.timer)
      this.timer = null
    }
    this.pending = false
  }

  isPending(): boolean {
    return this.pending
  }
}
