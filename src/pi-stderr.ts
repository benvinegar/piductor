const ANSI_ESCAPE_REGEX = /\x1B\[[0-9;?]*[ -/]*[@-~]/g

const IMPORTANT_STDERR_REGEX =
  /(error|failed|fatal|exception|traceback|denied|timed out|timeout|enoent|eacces|invalid|not found|unable to)/i

export function sanitizePiStderrLine(line: string): string {
  return line.replace(ANSI_ESCAPE_REGEX, "").replace(/\r/g, "").trim()
}

export function shouldSurfacePiStderr(line: string): boolean {
  const cleaned = sanitizePiStderrLine(line)
  if (!cleaned) return false
  return IMPORTANT_STDERR_REGEX.test(cleaned)
}
