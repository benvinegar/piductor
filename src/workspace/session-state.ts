import type { SendMode } from "../core/types"

export interface SendModeState {
  defaultMode: SendMode
  byWorkspace: Map<number, SendMode>
}

export function getWorkspaceSendMode(state: SendModeState, workspaceId: number | null): SendMode {
  if (!workspaceId) {
    return state.defaultMode
  }

  return state.byWorkspace.get(workspaceId) ?? state.defaultMode
}

export function setWorkspaceSendMode(
  state: SendModeState,
  workspaceId: number | null,
  mode: SendMode,
): SendModeState {
  if (!workspaceId) {
    return {
      defaultMode: mode,
      byWorkspace: state.byWorkspace,
    }
  }

  const nextByWorkspace = new Map(state.byWorkspace)
  nextByWorkspace.set(workspaceId, mode)

  return {
    defaultMode: state.defaultMode,
    byWorkspace: nextByWorkspace,
  }
}

export interface DraftState {
  globalDraft: string
  byWorkspace: Map<number, string>
}

export function switchWorkspaceDraft(
  state: DraftState,
  previousWorkspaceId: number | null,
  nextWorkspaceId: number | null,
  currentDraft: string,
): { state: DraftState; nextDraft: string } {
  const nextByWorkspace = new Map(state.byWorkspace)
  let nextGlobalDraft = state.globalDraft

  if (previousWorkspaceId) {
    nextByWorkspace.set(previousWorkspaceId, currentDraft)
  } else {
    nextGlobalDraft = currentDraft
  }

  const nextDraft = nextWorkspaceId ? (nextByWorkspace.get(nextWorkspaceId) ?? "") : nextGlobalDraft

  return {
    state: {
      globalDraft: nextGlobalDraft,
      byWorkspace: nextByWorkspace,
    },
    nextDraft,
  }
}

export function clearDraftForWorkspace(state: DraftState, workspaceId: number | null): DraftState {
  if (!workspaceId) {
    return {
      globalDraft: "",
      byWorkspace: state.byWorkspace,
    }
  }

  const nextByWorkspace = new Map(state.byWorkspace)
  nextByWorkspace.set(workspaceId, "")

  return {
    globalDraft: state.globalDraft,
    byWorkspace: nextByWorkspace,
  }
}
