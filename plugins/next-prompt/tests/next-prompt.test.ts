import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Candidate, Sent } from '../types'
import { filter, habits, match, parse, request, statusText } from '../hooks/suggest'

const CWD = 'D:/repo'

/**
 * The world beneath the plugin: a clock, a status line, an in-memory store,
 * a fork that answers `reply`, a prompt box that shows what it is given, and
 * a recorder of every state write.
 */
function world(on: On, opts: { reply?: string; store?: Record<string, unknown> } = {}) {
  mock.clock(on, { now: 1_000 })
  const status: Array<string | undefined> = []
  on('ui.status', (_$, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: CWD }))
  const store: Record<string, unknown> = { ...opts.store }
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  const forks: string[] = []
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)
    return {
      value:
        opts.reply === undefined
          ? { isAnswered: false, reason: 'empty-reply', usage: usage() }
          : { isAnswered: true, text: opts.reply, usage: usage() },
    }
  })
  const shown: string[] = []
  on('prompt.suggest', (_$, e) => {
    shown.push(e.text)
    return { isShown: true }
  })
  const filled: string[] = []
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('prompt.submit', () => ({ text: '' }))
  const state: Record<string, unknown> = {}
  on('state.set', (_$, e, next) => {
    state[String(e.key)] = e.value
    return next(e)
  })
  return {
    status,
    store,
    forks,
    shown,
    filled,
    candidates: () => (state.candidates ?? []) as Candidate[],
    history: () => (store.history ?? []) as Sent[],
  }
}

const usage = () => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
})

// The engine's own guess after a turn.
const engineGuess = ($: Engine, text: string) =>
  $.prompt.suggest({ text, origin: { kind: 'suggestion' } } as never)

test('clean-up drops fillers, the last prompt, ignored and repeated guesses', () => {
  expect(
    filter(['1. push it', '- "Push it."', 'continue', 'ok push it', 'run the tests', 'x'.repeat(200)], {
      lastPrompt: 'ok push it',
      ignored: ['run the tests'],
    }),
  ).toEqual(['push it'])
  expect(parse('1. push it\n\n- "run the tests"\n')).toEqual(['push it', 'run the tests'])
})

test('a sent prompt is matched to the guess it took, as is or edited', () => {
  const offered = ['push it', 'update the docs and push']
  expect(match('Push it.', offered)).toEqual({ taken: 0, isEdited: false })
  expect(match('update the docs and push to main', offered)).toEqual({ taken: 1, isEdited: true })
  expect(match('something else', offered)).toEqual({ taken: -1, isEdited: false })
})

test('habits read this project first and count repeated short prompts', () => {
  const sent = (text: string, cwd = CWD, offered: string[] = [], taken = -1): Sent => ({ cwd, at: 0, text, offered, taken })
  const history = [
    sent('elsewhere', 'D:/other'),
    ...['push it', 'push it', 'lets do it', 'yes', 'push it'].map(text => sent(text)),
    sent('fix the bug', CWD, ['run the tests'], -1),
    sent('fix more', CWD, ['run the tests'], -1),
  ]
  const h = habits(history, CWD)
  expect(h.recent).not.toContain('elsewhere')
  expect(h.frequent[0]).toEqual({ text: 'push it', count: 3 })
  expect(h.ignored).toEqual(['run the tests'])
  const asked = request({ habits: h, engineGuess: 'commit it', lastAnswer: 'Want me to push?' })
  expect(asked).toContain('push it (3x)')
  expect(asked).toContain('- run the tests')
  expect(asked).toContain('commit it')
  expect(asked).toContain('Want me to push?')
})

test("the engine's guess is replaced by ranked guesses, its own kept last", async ($, on) => {
  const w = world(on, { reply: '1. push it\n2. run the tests\ncontinue' })
  await engineGuess($, 'commit the change')
  expect(w.forks.length).toBe(1)
  expect(w.shown).toEqual(['push it'])
  expect(w.candidates().map(one => one.text)).toEqual(['push it', 'run the tests', 'commit the change'])
  expect(w.candidates().map(one => one.source)).toEqual(['model', 'model', 'engine'])
})

test("with the mod off or the fork failing, the engine's guess is cleaned and shown", async ($, on) => {
  const w = world(on, { store: { isEnabled: false } })
  await engineGuess($, '"commit the change"')
  expect(w.forks.length).toBe(0)
  expect(w.shown).toEqual(['commit the change'])
})

test('the status line says when the guess is done, and clears on the next prompt', async ($, on) => {
  const w = world(on, { reply: 'push it\nrun the tests' })
  await engineGuess($, 'commit it')
  expect(w.status).toContain('next: guessing…')
  expect(w.status.at(-1)).toMatch(/^next: ✓ 3 ideas in \d+\.\ds · \/next$/)
  await $.prompt.submit({ text: 'push it', wait: false, origin: { kind: 'composer' } })
  expect(w.status.at(-1)).toBeUndefined()
  expect(statusText(false, { count: 1, ms: 2_340 })).toBe('next: ✓ 1 idea in 2.3s · /next')
  expect(statusText(false, { count: 0, ms: 900 })).toBe('next: ✓ nothing worth showing (0.9s)')
})

test('a filler guess with nothing better is not shown', async ($, on) => {
  const w = world(on)
  const shown = await engineGuess($, 'continue')
  expect(shown).toEqual({ isShown: false })
  expect(w.shown).toEqual([])
})

test('a sent prompt is recorded with the guess it took, and the guesses clear', async ($, on) => {
  const w = world(on, { reply: 'push it\nrun the tests' })
  await engineGuess($, 'commit it')
  await $.prompt.submit({ text: 'run the tests', wait: false, origin: { kind: 'composer' } })
  expect(w.history()).toEqual([
    { cwd: CWD, at: 1_000, text: 'run the tests', offered: ['push it', 'run the tests', 'commit it'], taken: 1 },
  ])
  expect(w.candidates()).toEqual([])
})

test('/next 2 puts the second guess in the box; /next stats counts what was taken', async ($, on) => {
  const w = world(on, { reply: 'push it\nrun the tests' })
  await engineGuess($, 'commit it')
  const picked = await $.command.run({ command: 'next', args: '2' } as never)
  expect(w.filled).toEqual(['run the tests'])
  expect(picked.text).toContain('Guess 2')
  await $.prompt.submit({ text: 'run the tests', wait: false, origin: { kind: 'composer' } })
  const s = await $.command.run({ command: 'next', args: 'stats' } as never)
  expect(s.text).toContain('Taken: 1 (100%)')
})

test("another plugin's suggestion passes through untouched", async ($, on) => {
  const w = world(on, { reply: 'push it' })
  await $.prompt.suggest({ text: 'continue', origin: { kind: 'plugin', name: 'other' } })
  expect(w.forks.length).toBe(0)
  expect(w.shown).toEqual(['continue'])
})

test('a slash command keeps the guesses and is not recorded', async ($, on) => {
  const w = world(on, { reply: 'push it' })
  await engineGuess($, 'commit it')
  await $.prompt.submit({
    text: '/next 2',
    wait: false,
    origin: { kind: 'composer' },
    command: { name: 'next', args: '2' },
  } as never)
  expect(w.history()).toEqual([])
  expect(w.candidates().map(one => one.text)).toEqual(['push it', 'commit it'])
})

test('/next with no guesses says why', async ($, on) => {
  world(on)
  const before = await $.command.run({ command: 'next', args: '' } as never)
  expect(before.text).toContain('has not made a next-prompt suggestion')
  await engineGuess($, 'continue')
  const after = await $.command.run({ command: 'next', args: '' } as never)
  expect(after.text).toContain('the extra guess failed (empty-reply)')
})

test('a /next guess is never offered', () => {
  expect(filter(['/next', '/next 2', '/nextstep later', 'push it'])).toEqual(['/nextstep later', 'push it'])
})

const BAND = {
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`chips above the prompt put a guess in the box (${surface})`, async ($, on) => {
    const w = world(on, { reply: 'push it\nrun the tests' })
    on('ui.render', () => ({ type: 'engine', ref: 0 }))
    await engineGuess($, 'commit it')
    const band = await $.ui.mount({ plugin: 'next-prompt', surface, ...BAND })
    expect(await band.find({ key: 'chip-0', text: 'push it' })).toBeDefined()
    await band.press({ key: 'chip-2' })
    expect(w.filled).toEqual(['commit it'])
  })
}

test('/next ui switches the places guesses show', async ($, on) => {
  const w = world(on, { reply: 'push it\nrun the tests' })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  const listed = await $.command.run({ command: 'next', args: 'ui' } as never)
  expect(listed.text).toContain('[x] chips')
  const set = await $.command.run({ command: 'next', args: 'ui hint' } as never)
  expect(set.text).toContain('[ ] chips')
  expect(set.text).toContain('[x] hint')
  expect(w.store.ui).toEqual(['hint'])
  await engineGuess($, 'commit it')
  const band = await $.ui.mount({ plugin: 'next-prompt', surface: 'terminal', ...BAND })
  expect(await band.find({ key: 'chip-0' })).toBeUndefined()
})
