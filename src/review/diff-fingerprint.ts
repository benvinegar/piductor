export type DiffFingerprintStat = {
  path: string
  added: number | null
  removed: number | null
  status: string
}

export function diffFingerprintFromStats(stats: DiffFingerprintStat[]): string {
  if (stats.length === 0) {
    return ""
  }

  return stats.map((entry) => `${entry.status}:${entry.path}:${entry.added ?? "?"}:${entry.removed ?? "?"}`).join("|")
}
