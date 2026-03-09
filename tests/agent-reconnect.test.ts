import { describe, expect, it } from "vitest"
import { planAgentReconnect } from "../src/agent/reconnect"
import type { AgentRecord } from "../src/core/types"

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    workspaceId: 1,
    status: "running",
    pid: 123,
    model: "anthropic/claude-sonnet-4-20250514",
    sessionId: "session-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    stoppedAt: null,
    lastEventAt: "2026-01-01T00:00:00.000Z",
    lastError: null,
    ...overrides,
  }
}

describe("planAgentReconnect", () => {
  it("restarts missing running agents", () => {
    const action = planAgentReconnect({
      workspaceStatus: "active",
      agent: agent({ status: "running", pid: 42 }),
      pidAlive: false,
    })

    expect(action.type).toBe("restart")
  })

  it("marks orphaned running agents with live pid", () => {
    const action = planAgentReconnect({
      workspaceStatus: "active",
      agent: agent({ status: "running", pid: 42 }),
      pidAlive: true,
    })

    expect(action.type).toBe("mark_orphaned")
  })

  it("marks archived workspace agents stopped", () => {
    const action = planAgentReconnect({
      workspaceStatus: "archived",
      agent: agent({ status: "running" }),
      pidAlive: false,
    })

    expect(action.type).toBe("mark_stopped")
  })

  it("skips already stopped agents", () => {
    const action = planAgentReconnect({
      workspaceStatus: "active",
      agent: agent({ status: "stopped", pid: null }),
      pidAlive: false,
    })

    expect(action.type).toBe("skip")
  })
})
