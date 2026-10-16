import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Candidate, LastRun, Sent, UiMode } from '../types'
import { HISTORY_CAP, MAX_CANDIDATES, filter, habits, match, parse, request, stats, statusText } from './suggest'

const ANSWER_TAIL = 1500
const SENT_CAP = 300

const candidates = atom({ plugin: 'next-prompt', key: 'candidates' } as const, [] as Candidate[])
const lastAnswer = atom({ plugin: 'next-prompt', key: 'lastAnswer' } as const, '')
const isThinking = atom({ plugin: 'next-prompt', key: 'isThinking' } as const, false)
const lastEvent = atom({ plugin: 'next-prompt', key: 'lastEvent' } as const, '')
const lastRun = atom({ plugin: 'next-prompt', key: 'lastRun' } as const, null as LastRun | null)
const UI_MODES: readonly UiMode[] = ['chips', 'hint']

const ui = atom({ plugin: 'next-prompt', key: 'ui' } as const, [...UI_MODES])
const UI_HELP = {
  chips: 'a row of clickable guesses above the prompt',
  hint: 'the other guesses at the end of the hint line under the prompt',
} satisfies Record<UiMode, string>

async function storedUi($: EngineInterface): Promise<UiMode[]> {
  const value = await $.store.get('ui')
  return Array.isArray(value) ? value.filter((one): one is UiMode => UI_MODES.includes(one)) : [...UI_MODES]
}

async function history($: EngineInterface): Promise<Sent[]> {
  const value = await $.store.get('history')
  return Array.isArray(value) ? (value as Sent[]) : []
}

async function isEnabled($: EngineInterface): Promise<boolean> {
  return (await $.store.get('isEnabled')) !== false
}

async function refreshStatus($: EngineInterface): Promise<void> {
  await $.ui.status(statusText(await read($, isThinking), await read($, lastRun)))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'next',
      description:
        'List the guesses for your next prompt; "/next 2" puts guess 2 in the box, "/next ui" picks where they show, "/next stats" shows how often they were taken, "/next off|on" switches the mod, "/next forget" clears what it learned',
      argumentHint: '[1-4|ui|stats|off|on|forget]',
    })
    await update($, isThinking, () => false)
    await update($, lastRun, () => null)
    const modes = await storedUi($)
    await update($, ui, () => modes)
    await refreshStatus($)

    return next(e)
  })

  // Learn: what the person sent, and which guess (if any) it was. A slash
  // command is no answer to the guesses (and /next must still see them).
  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta || e.command) return next(e)
    const offered = (await read($, candidates)).map(one => one.text)
    const { taken, isEdited } = match(e.text, offered)
    const sent: Sent = {
      cwd: await $.session.cwd(),
      at: await $.clock.now(),
      text: e.text.slice(0, SENT_CAP),
      offered,
      taken,
      ...(isEdited ? { isEdited } : {}),
    }
    const all = await history($)
    await $.store.set('history', [...all, sent].slice(-HISTORY_CAP))
    await update($, candidates, () => [])
    await update($, lastRun, () => null)
    await refreshStatus($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && !e.isAborted && e.answer.length > 0) {
      await update($, lastAnswer, () => e.answer.slice(-ANSWER_TAIL))
    }

    return next(e)
  })

  // Replace the engine's one guess with ranked guesses of our own.
  on('prompt.suggest', async ($, e, next) => {
    if (e.origin.kind !== 'suggestion') return next(e)
    await update($, lastEvent, () => 'guessing')
    const startedAt = await $.clock.now()
    const all = await history($)
    const cwd = await $.session.cwd()
    const learned = habits(all, cwd)
    const lastPrompt = all.at(-1)?.text
    const engine = filter([e.text], { lastPrompt, ignored: learned.ignored })

    let model: string[] = []
    if (await isEnabled($)) {
      await update($, isThinking, () => true)
      await refreshStatus($)
      try {
        const reply = await $.model.fork({
          prompt: request({
            habits: learned,
            engineGuess: engine[0],
            lastAnswer: (await read($, lastAnswer)) || undefined,
          }),
        })
        if (reply.isAnswered) model = filter(parse(reply.text), { lastPrompt, ignored: learned.ignored })
        else await update($, lastEvent, () => `the extra guess failed (${reply.reason})`)
      } catch (err) {
        await update($, lastEvent, () => `the extra guess failed (${String(err).slice(0, 200)})`)
      } finally {
        await update($, isThinking, () => false)
      }
    }

    const list: Candidate[] = [
      ...model.map(text => ({ text, source: 'model' as const })),
      ...engine.map(text => ({ text, source: 'engine' as const })),
    ]
    const kept = filter(list.map(one => one.text)).slice(0, MAX_CANDIDATES)
    const ranked = kept.map(text => list.find(one => one.text === text) as Candidate)
    await update($, candidates, () => ranked)
    const ms = (await $.clock.now()) - startedAt
    await update($, lastRun, () => ({ count: ranked.length, ms }))
    await refreshStatus($)

    const [best] = ranked
    if (!best) {
      await update($, lastEvent, was => (was.startsWith('the extra') ? was : 'every guess was filtered out'))
      return { isShown: false }
    }
    await update($, lastEvent, () => '')
    return next({ ...e, text: best.text })
  })

  on('command.run', { command: 'next' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const list = await read($, candidates)

    if (arg === 'off' || arg === 'on') {
      await $.store.set('isEnabled', arg === 'on')
      return {
        text:
          arg === 'on'
            ? 'next-prompt is on: guesses are made from your habits after each turn.'
            : "next-prompt is off: Claude Code's own guess is shown, cleaned up, and nothing extra is asked of the model.",
      }
    }
    if (arg === 'ui' || arg.startsWith('ui ')) {
      const asked = arg.slice(2).trim().split(/[\s,]+/).filter(Boolean)
      if (asked.length > 0) {
        const modes = asked.includes('all') ? [...UI_MODES] : asked.includes('none') ? [] : UI_MODES.filter(m => asked.includes(m))
        await $.store.set('ui', modes)
        await update($, ui, () => modes)
      }
      const now = await read($, ui)
      const rows = UI_MODES.map(m => `${now.includes(m) ? '[x]' : '[ ]'} ${m}: ${UI_HELP[m]}`)
      return {
        text: `${rows.join('\n')}\n\nThe dim guess in the prompt box is always on. /next ui <${UI_MODES.join('|')}|all|none> [...] picks.`,
      }
    }
    if (arg === 'stats') {
      const s = stats(await history($))
      const pct = (n: number) => (s.offered === 0 ? '0%' : `${Math.round((n / s.offered) * 100)}%`)
      return {
        text: `${s.prompts} prompts recorded; guesses were on offer for ${s.offered}. Taken: ${s.taken} (${pct(s.taken)}), the first guess as is: ${s.first} (${pct(s.first)}).`,
      }
    }
    if (arg === 'forget') {
      await $.store.delete('history')
      return { text: 'next-prompt forgot every recorded prompt.' }
    }
    if (/^[1-9]$/.test(arg)) {
      const pick = list[Number(arg) - 1]
      if (!pick) return { text: `There is no guess ${arg}; there are ${list.length}.` }
      await $.prompt.fill({ text: pick.text })
      return { text: `Guess ${arg} is in the prompt box.` }
    }
    if (list.length === 0) {
      const event = await read($, lastEvent)
      const why =
        event === ''
          ? "Claude Code has not made a next-prompt suggestion since the mod loaded (check that prompt suggestions are on in /config)."
          : event === 'guessing'
            ? 'A guess is being made now.'
            : `The last suggestion: ${event}.`
      return { text: `No guesses yet. ${why}` }
    }
    const lines = list.map((one, i) => `${i + 1}. ${one.text}${one.source === 'engine' ? ' (Claude Code)' : ''}`).join('\n')
    return { text: `${lines}\n\n/next <n> puts one in the prompt box.` }
  })

  // Chips: a row of the guesses above the prompt, under whatever the band holds.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const list = await read($, candidates)
    if (e.props.hasSurvey || e.props.isWorking || list.length === 0 || !(await read($, ui)).includes('chips')) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const each = Math.max(8, Math.floor((e.props.bodyColumns - 6) / list.length) - 5)
    const row = (
      <Box key="next-chips" flexDirection="row" flexWrap="wrap">
        <Text dimColor>Next </Text>
        {list.map((one, i) => (
          <Button key={`chip-${i}`} plain hotkey={String(i + 1)} onPress={() => $.prompt.fill({ text: one.text })}>
            {one.text.length > each ? `${one.text.slice(0, each - 1)}…` : one.text}
            {'  '}
          </Button>
        ))}
      </Box>
    )
    if (below.type === 'engine') return row

    return (
      <Box flexDirection="column">
        {below}
        {row}
      </Box>
    )
  })

  // Hint line: the other guesses at the end of the line under the prompt.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const list = await read($, candidates)
    if (e.props.isDraft || e.props.isWorking || list.length < 2 || !(await read($, ui)).includes('hint')) return next(e)
    const rest = list
      .slice(1)
      .map((one, i) => `${i + 2}: ${one.text}`)
      .join(' · ')

    return next({ ...e, props: { ...e.props, tail: `  next ${rest} (/next <n>)` } })
  })
}
