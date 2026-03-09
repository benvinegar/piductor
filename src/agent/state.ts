import type { AgentRuntimeStatus } from "../core/types"

export interface AgentTimingState {
  status: AgentRuntimeStatus
  startedAt: string | null
  stoppedAt: string | null
  lastEventAt: string | null
}

export interface NextAgentTimingInput {
  current: AgentTimingState | null
  status: AgentRuntimeStatus
  nowIso: string
  lastEventAt?: string | null
}

function isActiveStatus(status: AgentRuntimeStatus): boolean {
  return status === "starting" || status === "running"
}

export function nextAgentTimingState(input: NextAgentTimingInput): AgentTimingState {
  const current = input.current
  const enteringActive = isActiveStatus(input.status)
  const previouslyActive = current ? isActiveStatus(current.status) : false

  const startedAt = enteringActive
    ? previouslyActive
      ? (current?.startedAt ?? input.nowIso)
      : input.nowIso
    : current?.startedAt ?? null

  const stoppedAt = enteringActive ? null : input.nowIso
  const lastEventAt = input.lastEventAt === undefined ? input.nowIso : input.lastEventAt

  return {
    status: input.status,
    startedAt,
    stoppedAt,
    lastEventAt,
  }
}
