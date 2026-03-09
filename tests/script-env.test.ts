import { describe, expect, it } from "vitest"
import { buildWorkspaceScriptEnv, workspaceBasePort } from "../src/run/script-env"
import type { RepoRecord, WorkspaceRecord } from "../src/core/types"

const repo: RepoRecord = {
  id: 1,
  name: "modem",
  rootPath: "/tmp/modem",
  createdAt: "2026-01-01T00:00:00.000Z",
}

const workspace: WorkspaceRecord = {
  id: 7,
  repoId: 1,
  name: "feature-x",
  branch: "pc/feature-x",
  worktreePath: "/tmp/modem-worktree",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
}

describe("workspaceBasePort", () => {
  it("allocates deterministic 10-port blocks", () => {
    expect(workspaceBasePort(0)).toBe(43000)
    expect(workspaceBasePort(7)).toBe(43070)
  })
})

describe("buildWorkspaceScriptEnv", () => {
  it("injects PIDUCTOR_* vars and CONDUCTOR_* aliases", () => {
    const env = buildWorkspaceScriptEnv({
      baseEnv: { PATH: "/bin" },
      repo,
      workspace,
      defaultBranch: "main",
    })

    expect(env.PATH).toBe("/bin")

    expect(env.PIDUCTOR_WORKSPACE_NAME).toBe("feature-x")
    expect(env.PIDUCTOR_WORKSPACE_PATH).toBe("/tmp/modem-worktree")
    expect(env.PIDUCTOR_ROOT_PATH).toBe("/tmp/modem")
    expect(env.PIDUCTOR_DEFAULT_BRANCH).toBe("main")
    expect(env.PIDUCTOR_PORT).toBe("43070")

    expect(env.CONDUCTOR_WORKSPACE_NAME).toBe("feature-x")
    expect(env.CONDUCTOR_WORKSPACE_PATH).toBe("/tmp/modem-worktree")
    expect(env.CONDUCTOR_ROOT_PATH).toBe("/tmp/modem")
    expect(env.CONDUCTOR_DEFAULT_BRANCH).toBe("main")
    expect(env.CONDUCTOR_PORT).toBe("43070")
  })
})
