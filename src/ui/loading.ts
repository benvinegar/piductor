export const LOADING_TOKEN = "{{loading}}"
export const LOADING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

export function renderLoadingTokens(text: string, frameIndex: number): string {
  const frame = LOADING_FRAMES[Math.abs(frameIndex) % LOADING_FRAMES.length] ?? "•"
  return text.replaceAll(LOADING_TOKEN, frame)
}
