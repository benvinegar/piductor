import { describe, expect, it, vi } from "vitest"
import { UiFlushScheduler } from "../src/ui-flush-scheduler"

describe("ui-flush-scheduler", () => {
  it("coalesces multiple schedules into one flush", () => {
    vi.useFakeTimers()

    const flush = vi.fn()
    const scheduler = new UiFlushScheduler(50, flush)

    scheduler.schedule()
    scheduler.schedule()
    scheduler.schedule()

    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(49)
    expect(flush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(flush).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it("flushNow emits immediately and clears pending timer", () => {
    vi.useFakeTimers()

    const flush = vi.fn()
    const scheduler = new UiFlushScheduler(100, flush)

    scheduler.schedule()
    expect(scheduler.isPending()).toBe(true)

    scheduler.flushNow()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(scheduler.isPending()).toBe(false)

    vi.advanceTimersByTime(100)
    expect(flush).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it("cancel drops pending flush", () => {
    vi.useFakeTimers()

    const flush = vi.fn()
    const scheduler = new UiFlushScheduler(20, flush)

    scheduler.schedule()
    scheduler.cancel()

    vi.advanceTimersByTime(25)
    expect(flush).not.toHaveBeenCalled()

    vi.useRealTimers()
  })
})
