export interface ParsedPrCreateArgs {
  dryRun: boolean
}

export function parsePrCreateArgs(args: string[]): ParsedPrCreateArgs | null {
  let dryRun = false

  for (const token of args) {
    if (token === "--dry-run") {
      dryRun = true
      continue
    }

    return null
  }

  return { dryRun }
}

export function prCreateUsage() {
  return "Usage: /pr create [--dry-run]"
}

export function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/)
  return match ? match[0] : null
}
