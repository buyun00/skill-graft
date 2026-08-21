import type { InboxSuggestionView } from '../contracts/index.js'
import { transitionInbox } from './policies.js'
import { cloneHubState, type HubStateDocument } from './use-case-plan-types.js'

export type AnalyzeCompletionFact = {
  sessionId: string
  outcome: 'pending' | 'succeeded' | 'failed' | 'cancelled'
  output: string
  inboxIds: readonly string[]
}

export type AnalyzeCompletionPlanDecision =
  | {
      decision: 'noop'
      reason: 'not-succeeded' | 'invalid-output' | 'no-change'
    }
  | {
      decision: 'apply'
      plan: {
        nextState: HubStateDocument
        changedItemIds: readonly string[]
        suggestion: InboxSuggestionView
      }
    }

export function extractInboxSuggestion(text: string): InboxSuggestionView | null {
  const raw = String(text || '')
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : raw
  const start = body.search(/[\[{]/)
  if (start < 0) return null
  const sliced = body.slice(start)
  let parsed: unknown
  try {
    parsed = JSON.parse(sliced)
  } catch {
    const end = Math.max(sliced.lastIndexOf('}'), sliced.lastIndexOf(']'))
    if (end < 0) return null
    try {
      parsed = JSON.parse(sliced.slice(0, end + 1))
    } catch {
      return null
    }
  }
  const row = Array.isArray(parsed) ? parsed[0] : parsed
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  const action = String(record.action || record.suggestion || '').trim()
  if (!action) return null
  return {
    action,
    target: String(record.target || ''),
    reason: String(record.reason || record.summary || ''),
    confidence: String(record.confidence || '')
  }
}

function sameSuggestion(left: InboxSuggestionView | undefined, right: InboxSuggestionView): boolean {
  return (left?.action || '') === (right.action || '')
    && (left?.target || '') === (right.target || '')
    && (left?.reason || '') === (right.reason || '')
    && (left?.confidence || '') === (right.confidence || '')
}

export function planAnalyzeCompletion(input: {
  state: HubStateDocument
  fact: AnalyzeCompletionFact
  now: string
}): AnalyzeCompletionPlanDecision {
  if (input.fact.outcome !== 'succeeded') return { decision: 'noop', reason: 'not-succeeded' }
  const suggestion = extractInboxSuggestion(input.fact.output)
  if (!suggestion) return { decision: 'noop', reason: 'invalid-output' }

  const selectedIds = new Set(input.fact.inboxIds.filter(Boolean))
  const nextState = cloneHubState(input.state)
  const changedItemIds: string[] = []
  for (const item of nextState.items) {
    if (selectedIds.size > 0 && !selectedIds.has(item.id)) continue
    if (selectedIds.size === 0 && item.status !== 'queued' && item.status !== 'proposed') continue
    const transition = transitionInbox(item.status, 'propose')
    if (!transition.accepted) continue
    if (transition.idempotent && sameSuggestion(item.suggestion, suggestion)) continue
    item.suggestion = { ...suggestion }
    item.status = transition.next
    item.updatedAt = input.now
    changedItemIds.push(item.id)
  }
  if (changedItemIds.length === 0) return { decision: 'noop', reason: 'no-change' }
  return {
    decision: 'apply',
    plan: { nextState, changedItemIds, suggestion }
  }
}
