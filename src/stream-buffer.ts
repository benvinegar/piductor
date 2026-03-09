export function consumeBufferedLines(
  existingBuffer: string,
  chunk: string,
  maxRemainderChars: number,
): { lines: string[]; remainder: string } {
  const combined = `${existingBuffer}${chunk}`
  const parts = combined.split(/\r?\n/)
  const lines = parts.slice(0, -1)
  let remainder = parts[parts.length - 1] ?? ""

  if (remainder.length > maxRemainderChars) {
    const overflowLen = remainder.length - maxRemainderChars
    const overflow = remainder.slice(0, overflowLen)
    if (overflow.length > 0) {
      lines.push(overflow)
    }
    remainder = remainder.slice(-maxRemainderChars)
  }

  return { lines, remainder }
}
