import { describe, expect, it, vi } from "vitest"
import { killProcessByPid } from "../src/process-kill"

describe("process-kill helpers", () => {
  it("kills process group first on non-windows", () => {
    const killFn = vi.fn()

    const result = killProcessByPid(1234, { platform: "linux", killFn, signal: "SIGKILL" })

    expect(result).toBe("killed")
    expect(killFn).toHaveBeenCalledWith(-1234, "SIGKILL")
  })

  it("falls back to direct pid kill when group kill fails", () => {
    const killFn = vi
      .fn()
      .mockImplementationOnce(() => {
        const error = new Error("no group") as Error & { code?: string }
        error.code = "EPERM"
        throw error
      })
      .mockImplementationOnce(() => undefined)

    const result = killProcessByPid(222, { platform: "linux", killFn })

    expect(result).toBe("killed")
    expect(killFn).toHaveBeenNthCalledWith(1, -222, "SIGKILL")
    expect(killFn).toHaveBeenNthCalledWith(2, 222, "SIGKILL")
  })

  it("returns missing when process does not exist", () => {
    const killFn = vi.fn(() => {
      const error = new Error("missing") as Error & { code?: string }
      error.code = "ESRCH"
      throw error
    })

    const result = killProcessByPid(99, { platform: "win32", killFn })

    expect(result).toBe("missing")
  })
})
