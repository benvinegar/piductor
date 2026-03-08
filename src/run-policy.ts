import type { ScriptConfig } from "./types"

export function shouldStopExistingRun(runMode: ScriptConfig["runMode"], hasExisting: boolean): boolean {
  return Boolean(hasExisting && runMode === "nonconcurrent")
}

export function stopSignalSequence(): readonly ["SIGHUP", "SIGKILL"] {
  return ["SIGHUP", "SIGKILL"]
}
