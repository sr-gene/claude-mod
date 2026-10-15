import type { Sent } from '../types'

export const MAX_CANDIDATES = 4
export const MAX_LENGTH = 160
export const HISTORY_CAP = 300

/** Fillers that are never worth a suggestion of their own. */
const FILLERS = new Set(['continue', 'go on', 'thanks', 'thank you', 'ok', 'okay', 'k', 'cool', 'nice', 'great'])

const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[\s.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** One raw line of the model's reply as a prompt: numbering, bullets and quotes removed. */
export function clean(line: string): string {
  return line
    .trim()
    .replace(/^(\d+[.)]|[-*•▸>])\s+/, '')
    .replace(/^["'`“”]+|["'`“”]+$/g, '')
    .trim()
}

/**
 * Keeps the candidates worth showing, in order: cleaned, one line, not too
 * long, no filler, not the prompt just sent, not one the person keeps
 * ignoring, no duplicates.
 */
export function filter(texts: readonly string[], opts: { lastPrompt?: string; ignored?: readonly string[] } = {}) {
  const last = opts.lastPrompt ? norm(opts.lastPrompt) : undefined
  const ignored = new Set((opts.ignored ?? []).map(norm))
  const seen = new Set<string>()
  const kept: string[] = []
  for (const raw of texts) {
    const text = clean(raw.split('\n')[0] ?? '')
    const key = norm(text)
    if (key.length === 0 || text.length > MAX_LENGTH) continue
    if (FILLERS.has(key) || key === last || ignored.has(key) || seen.has(key)) continue
    if (/^\/next(\s|$)/.test(key)) continue
    seen.add(key)
    kept.push(text)
  }
  return kept
}

/** Splits the model's reply into candidate lines. */
export function parse(reply: string): string[] {
  return reply
    .split('\n')
    .map(clean)
    .filter(line => line.length > 0)
}

/** Which offered candidate a sent prompt is: taken as is, edited from one, or none. */
export function match(text: string, offered: readonly string[]): { taken: number; isEdited: boolean } {
  const sent = norm(text)
  const exact = offered.findIndex(one => norm(one) === sent)
  if (exact >= 0) return { taken: exact, isEdited: false }
  const edited = offered.findIndex(one => {
    const o = norm(one)
    return o.length >= 8 && (sent.startsWith(o) || o.startsWith(sent)) && sent.length >= 4
  })
  return edited >= 0 ? { taken: edited, isEdited: true } : { taken: -1, isEdited: false }
}

/** The history for this project first, then the rest, newest last. */
function relevant(history: readonly Sent[], cwd: string) {
  const here = history.filter(one => one.cwd === cwd)
  return here.length >= 5 ? here : history
}

export type Habits = {
  /** The person's recent prompts, oldest first. */
  recent: string[]
  /** Short prompts they send again and again, with how often. */
  frequent: Array<{ text: string; count: number }>
  /** Suggestions offered and passed over at least twice lately. */
  ignored: string[]
}

export function habits(history: readonly Sent[], cwd: string): Habits {
  const mine = relevant(history, cwd)
  const recent = mine.slice(-15).map(one => one.text)
  const counts = new Map<string, { text: string; count: number }>()
  for (const one of history) {
    if (one.text.length > 40) continue
    const key = norm(one.text)
    const was = counts.get(key)
    counts.set(key, { text: was?.text ?? one.text, count: (was?.count ?? 0) + 1 })
  }
  const frequent = [...counts.values()]
    .filter(one => one.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
  const passed = new Map<string, { text: string; count: number }>()
  for (const one of mine.slice(-40)) {
    one.offered.forEach((text, i) => {
      if (i === one.taken) return
      const key = norm(text)
      const was = passed.get(key)
      passed.set(key, { text, count: (was?.count ?? 0) + 1 })
    })
  }
  const ignored = [...passed.values()].filter(one => one.count >= 2).map(one => one.text).slice(-10)
  return { recent, frequent, ignored }
}

/** The one user message the fork answers. */
export function request(opts: { habits: Habits; engineGuess?: string; lastAnswer?: string }): string {
  const { recent, frequent, ignored } = opts.habits
  const lines = [
    'Do not continue the task and do not use tools. Guess what the person will type as their NEXT prompt in this session.',
    `Reply with 1 to ${MAX_CANDIDATES} distinct candidates, most likely first, one per line, written as the person would type them (their voice, length and casing). No numbering, no quotes, no commentary. Each under ${MAX_LENGTH} characters.`,
    'Prefer the concrete next move the conversation points to (a step that was offered or left open, checking a result, committing, pushing) over generic replies. If the last answer ended with a question or an offer, include the likely answer to it.',
  ]
  if (opts.lastAnswer) lines.push('', 'Your last answer ended:', opts.lastAnswer)
  if (recent.length > 0) lines.push('', 'Their recent prompts, oldest first:', ...recent.map(text => `- ${text}`))
  if (frequent.length > 0)
    lines.push('', 'Short prompts they often send:', ...frequent.map(one => `- ${one.text} (${one.count}x)`))
  if (ignored.length > 0) lines.push('', 'Suggestions they kept passing over (do not offer these):', ...ignored.map(text => `- ${text}`))
  if (opts.engineGuess) lines.push('', `Another guess, to use or improve on: ${opts.engineGuess}`)
  return lines.join('\n')
}

/** How often the person took a suggestion, for /next stats. */
export function stats(history: readonly Sent[]) {
  const offered = history.filter(one => one.offered.length > 0)
  const taken = offered.filter(one => one.taken >= 0)
  const first = taken.filter(one => one.taken === 0 && !one.isEdited)
  return { prompts: history.length, offered: offered.length, taken: taken.length, first: first.length }
}
