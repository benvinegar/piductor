import { describe, expect, it } from "vitest"
import { nextAgentTimingState } from "../src/agent-state"

describe("agent-state timing helpers", () => {
  it("sets startedAt when entering active state and preserves it while active", () => {
    const first = nextAgentTimingState({
      current: null,
      status: "starting",
      nowIso: "2026-03-08T23:40:00.000Z",
    })

    expect(first.startedAt).toBe("2026-03-08T23:40:00.000Z")
    expect(first.stoppedAt).toBeNull()

    const second = nextAgentTimingState({
      current: first,
      status: "running",
      nowIso: "2026-03-08T23:41:00.000Z",
    })

    expect(second.startedAt).toBe("2026-03-08T23:40:00.000Z")
    expect(second.stoppedAt).toBeNull()
  })

  it("sets stoppedAt when leaving active state", () => {
    const running = {
      status: "running" as const,
      startedAt: "2026-03-08T23:40:00.000Z",
      stoppedAt: null,
      lastEventAt: "2026-03-08T23:41:00.000Z",
    }

    const stopped = nextAgentTimingState({
      current: running,
      status: "stopped",
      nowIso: "2026-03-08T23:45:00.000Z",
    })

    expect(stopped.startedAt).toBe("2026-03-08T23:40:00.000Z")
    expect(stopped.stoppedAt).toBe("2026-03-08T23:45:00.000Z")
  })

  it("resets startedAt on restart after stop", () => {
    const stopped = {
      status: "stopped" as const,
      startedAt: "2026-03-08T23:40:00.000Z",
      stoppedAt: "2026-03-08T23:45:00.000Z",
      lastEventAt: "2026-03-08T23:45:00.000Z",
    }

    const restarted = nextAgentTimingState({
      current: stopped,
      status: "starting",
      nowIso: "2026-03-08T23:50:00.000Z",
    })

    expect(restarted.startedAt).toBe("2026-03-08T23:50:00.000Z")
    expect(restarted.stoppedAt).toBeNull()
  })

  it("tracks lastEventAt and supports explicit timestamps", () => {
    const implicit = nextAgentTimingState({
      current: null,
      status: "starting",
      nowIso: "2026-03-08T23:40:00.000Z",
    })
    expect(implicit.lastEventAt).toBe("2026-03-08T23:40:00.000Z")

    const explicit = nextAgentTimingState({
      current: implicit,
      status: "running",
      nowIso: "2026-03-08T23:41:00.000Z",
      lastEventAt: "2026-03-08T23:41:30.000Z",
    })
    expect(explicit.lastEventAt).toBe("2026-03-08T23:41:30.000Z")
  })
})
