import { describe, expect, it } from "vitest"
import type { SendMode } from "../src/types"
import {
  clearDraftForWorkspace,
  getWorkspaceSendMode,
  setWorkspaceSendMode,
  switchWorkspaceDraft,
  type DraftState,
  type SendModeState,
} from "../src/workspace-session-state"

describe("workspace-session-state helpers", () => {
  it("returns default send mode when no workspace-specific override exists", () => {
    const state: SendModeState = { defaultMode: "prompt", byWorkspace: new Map() }

    expect(getWorkspaceSendMode(state, null)).toBe("prompt")
    expect(getWorkspaceSendMode(state, 12)).toBe("prompt")
  })

  it("stores default mode and per-workspace mode independently", () => {
    let state: SendModeState = { defaultMode: "prompt", byWorkspace: new Map() }

    state = setWorkspaceSendMode(state, null, "steer")
    expect(getWorkspaceSendMode(state, null)).toBe("steer")
    expect(getWorkspaceSendMode(state, 1)).toBe("steer")

    state = setWorkspaceSendMode(state, 1, "follow_up")
    expect(getWorkspaceSendMode(state, 1)).toBe("follow_up")
    expect(getWorkspaceSendMode(state, 2)).toBe("steer")

    state = setWorkspaceSendMode(state, null, "prompt")
    expect(getWorkspaceSendMode(state, 1)).toBe("follow_up")
    expect(getWorkspaceSendMode(state, 2)).toBe("prompt")
  })

  it("switches drafts between global and workspace buffers", () => {
    let state: DraftState = {
      globalDraft: "global-draft",
      byWorkspace: new Map<number, string>(),
    }

    const toWorkspace1 = switchWorkspaceDraft(state, null, 1, "global-edit")
    state = toWorkspace1.state
    expect(toWorkspace1.nextDraft).toBe("")
    expect(state.globalDraft).toBe("global-edit")

    const toWorkspace2 = switchWorkspaceDraft(state, 1, 2, "ws1-edit")
    state = toWorkspace2.state
    expect(toWorkspace2.nextDraft).toBe("")
    expect(state.byWorkspace.get(1)).toBe("ws1-edit")

    const backToWorkspace1 = switchWorkspaceDraft(state, 2, 1, "ws2-edit")
    state = backToWorkspace1.state
    expect(backToWorkspace1.nextDraft).toBe("ws1-edit")
    expect(state.byWorkspace.get(2)).toBe("ws2-edit")

    const backToGlobal = switchWorkspaceDraft(state, 1, null, "ws1-new")
    expect(backToGlobal.state.byWorkspace.get(1)).toBe("ws1-new")
    expect(backToGlobal.nextDraft).toBe("global-edit")
  })

  it("clears only targeted draft buffer on submit", () => {
    let state: DraftState = {
      globalDraft: "global",
      byWorkspace: new Map<number, string>([
        [1, "ws1"],
        [2, "ws2"],
      ]),
    }

    state = clearDraftForWorkspace(state, 1)
    expect(state.byWorkspace.get(1)).toBe("")
    expect(state.byWorkspace.get(2)).toBe("ws2")
    expect(state.globalDraft).toBe("global")

    state = clearDraftForWorkspace(state, null)
    expect(state.globalDraft).toBe("")
    expect(state.byWorkspace.get(2)).toBe("ws2")
  })
})
