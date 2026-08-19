import type { IngestTransaction } from './types.js'

export function parseIngestTransactions(text: string): IngestTransaction[] {
  const rows: IngestTransaction[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) continue
    rows.push({ old: parts[0], next: parts[1], ref: parts.slice(2).join(' ') })
  }
  return rows
}

export function emptyIngestResult() {
  return { ok: true, action: 'ingest' as const, created: 0, items: [] as unknown[] }
}
