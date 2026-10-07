import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Activity, Step } from '../types'

const PLUGIN = 'step-tracker'

const PANE = {
  component: 'Pane' as const,
  requestId: 'steps',
  props: {
    title: 'Steps',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
}

const BAND = {
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 60,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
}

const SURFACES = ['terminal', 'desktop'] as const

// Tools that exist in no build. Once the engine has laid its tool table a
// matcher's `tool` and `$.tool.call`'s input are that build's closed union, so
// these are matched by RegExp and called through `callAny`; at run time the
// engine accepts any name and the test's own hook is the tool.
const DEMO = 'mcp__demo__lookup'
const BLOCKED = 'mcp__demo__blocked'
const callAny = ($: Engine, input: { tool: string } & Record<string, unknown>) => $.tool.call(input as never)

/**
 * The world beneath the plugin: a clock, a status line that accepts text, and
 * a recorder of every state write so a test can read the step list back.
 */
function world(on: On) {
  mock.clock(on, { now: 1_000 })
  const status: Array<string | undefined> = []
  on('ui.status', (_$, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  // The engine's own drawing, for a site the plugin passes on with next(e).
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  const state: Record<string, unknown> = {}
  on('state.set', (_$, e, next) => {
    state[String(e.key)] = e.value
    return next(e)
  })
  return {
    status,
    steps: () => (state.steps ?? []) as Step[],
    activity: () => (state.activity ?? []) as Activity[],
    phase: () => state.phase as string | undefined,
  }
}

function taskTools(on: On) {
  on('tool.call', { tool: 'TaskCreate' }, (_$, e) => ({
    result: { task: { id: `t-${e.subject}`, subject: e.subject } },
  }))
  on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => ({
    result: { success: true, taskId: e.taskId, updatedFields: ['status'] },
  }))
  on('tool.call', { tool: 'TodoWrite' }, (_$, e) => ({ result: { oldTodos: [], newTodos: e.todos } }))
}

type PaneSurface = (typeof SURFACES)[number]

async function onEverySurface($: Engine, check: (ui: Mounted<PaneSurface, 'Pane'>) => Promise<void>) {
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    await check(ui)
    await ui.unmount()
  }
}

test('TaskCreate and TaskUpdate fill the step list and the pane shows every step', async ($, on) => {
  const w = world(on)
  taskTools(on)

  const titles = ['Read the failing test', 'Fix the guard', 'Run the suite', 'Write the summary', 'Commit']
  for (const subject of titles) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: subject, activeForm: `${subject} (doing)` })
  }
  await $.tool.call({ tool: 'TaskUpdate', taskId: 't-Read the failing test', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: 't-Fix the guard', status: 'in_progress' })

  expect(w.steps().map(s => s.status)).toEqual(['completed', 'in_progress', 'pending', 'pending', 'pending'])
  expect(w.steps()[1]?.activeForm).toBe('Fix the guard (doing)')
  expect(w.status.at(-1)).toBe('steps: 1/5 Fix the guard')

  await onEverySurface($, async ui => {
    expect(await ui.find({ type: 'Text', text: /1\/5 done/ })).toBeDefined()
    for (const title of titles) {
      expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: /Fix the guard \(doing\)/ })).toBeDefined()
  })
})

test('TaskUpdate with status deleted removes the step', async ($, on) => {
  const w = world(on)
  taskTools(on)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Only step', description: 'x' })
  expect(w.steps()).toHaveLength(1)

  await $.tool.call({ tool: 'TaskUpdate', taskId: 't-Only step', status: 'deleted' })
  expect(w.steps()).toEqual([])
})

test('TodoWrite replaces the whole step list', async ($, on) => {
  const w = world(on)
  taskTools(on)

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Plan', status: 'completed', activeForm: 'Planning' },
      { content: 'Build', status: 'in_progress', activeForm: 'Building' },
      { content: 'Verify', status: 'pending', activeForm: 'Verifying' },
    ],
  })

  expect(w.steps().map(s => s.title)).toEqual(['Plan', 'Build', 'Verify'])
  expect(w.steps()[1]).toMatchObject({ status: 'in_progress', activeForm: 'Building' })

  await onEverySurface($, async ui => {
    expect(await ui.find({ type: 'Text', text: /1\/3 done/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Building/ })).toBeDefined()
  })
})

test('an ordinary tool call appears under Now and dims when it finishes', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: /^mcp__demo__lookup$/ }, () => ({ result: { ok: true } }))

  await callAny($, { tool: DEMO, query: 'anything' })

  expect(w.activity()).toHaveLength(1)
  expect(w.activity()[0]).toMatchObject({ tool: 'mcp__demo__lookup', isDone: true, startedAt: 1_000 })

  await onEverySurface($, async ui => {
    const row = await ui.find({ type: 'Text', text: /demo:lookup/ })
    expect(row).toBeDefined()
    expect(row?.props.dimColor).toBe(true)
  })
})

test('a denied tool call is marked as an error', async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: /^mcp__demo__blocked$/ }, () => ({ deny: 'not here' }))

  await callAny($, { tool: BLOCKED })

  expect(w.activity()[0]).toMatchObject({ tool: 'mcp__demo__blocked', isDone: true, isError: true })
})

test('task tool calls are not listed as activity', async ($, on) => {
  const w = world(on)
  taskTools(on)

  await $.tool.call({ tool: 'TaskCreate', subject: 'A step', description: 'x' })

  expect(w.activity()).toEqual([])
})

test('a new turn clears activity but keeps the step list; a new task after a finished list starts fresh', async ($, on) => {
  const w = world(on)
  taskTools(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', { tool: /^mcp__demo__lookup$/ }, () => ({ result: {} }))

  await $.tool.call({ tool: 'TaskCreate', subject: 'Open', description: 'x' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: 't-Open', status: 'in_progress' })
  await callAny($, { tool: DEMO })
  expect(w.activity()).toHaveLength(1)

  await $.turn.start({ text: 'again', turnId: 'turn-2' })
  expect(w.phase()).toBe('working')
  expect(w.activity()).toEqual([])
  expect(w.steps().map(s => s.title)).toEqual(['Open'])

  await $.tool.call({ tool: 'TaskUpdate', taskId: 't-Open', status: 'completed' })
  await $.turn.complete({ turnId: 'turn-2', answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' })
  expect(w.phase()).toBe('idle')

  await $.turn.start({ text: 'new job', turnId: 'turn-3' })
  expect(w.steps().map(s => s.title)).toEqual(['Open'])

  await $.tool.call({ tool: 'TaskCreate', subject: 'Fresh', description: 'x' })
  expect(w.steps().map(s => s.title)).toEqual(['Fresh'])
})

test('the pane draws an empty state before any step exists', async ($, on) => {
  world(on)
  await onEverySurface($, async ui => {
    expect(await ui.find({ type: 'Text', text: /No steps yet/ })).toBeDefined()
  })
})

test("the mod's own plan and step tools drive the list on any build", async ($, on) => {
  const w = world(on)

  const planned = await callAny($, {
    tool: 'mcp__step-tracker__plan',
    steps: [
      { title: 'Count files', activeForm: 'Counting files' },
      { title: 'Run tests', activeForm: 'Running tests' },
      { title: 'Summarise' },
    ],
  })
  expect(planned.deny).toBeUndefined()
  expect(w.steps().map(s => s.title)).toEqual(['Count files', 'Run tests', 'Summarise'])
  expect(w.steps().every(s => s.status === 'pending')).toBe(true)

  await callAny($, { tool: 'mcp__step-tracker__step', index: 1, status: 'in_progress' })
  expect(w.status.at(-1)).toBe('steps: 0/3 Count files')

  await callAny($, { tool: 'mcp__step-tracker__step', index: 1, status: 'completed' })
  await callAny($, { tool: 'mcp__step-tracker__step', index: 2, status: 'in_progress' })
  expect(w.steps().map(s => s.status)).toEqual(['completed', 'in_progress', 'pending'])

  const bad = await callAny($, { tool: 'mcp__step-tracker__step', index: 9, status: 'completed' })
  expect(typeof bad.deny).toBe('string')

  expect(w.activity()).toEqual([])

  await onEverySurface($, async ui => {
    expect(await ui.find({ type: 'Text', text: /1\/3 done/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Running tests/ })).toBeDefined()
  })
})

test('the band above the prompt shows the steps, and stays empty while idle with none', async ($, on) => {
  const w = world(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /Steps/ })).toBeUndefined()
    await ui.unmount()
  }

  await callAny($, {
    tool: 'mcp__step-tracker__plan',
    steps: [{ title: 'First', activeForm: 'Doing first' }, { title: 'Second' }],
  })
  await callAny($, { tool: 'mcp__step-tracker__step', index: 2, status: 'in_progress' })
  expect(w.steps()).toHaveLength(2)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /0\/2 done/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\. First/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2\. Second/ })).toBeDefined()
    await ui.unmount()
  }

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND, props: { ...BAND.props, hasSurvey: true } })
    expect(await ui.find({ type: 'Text', text: /Steps/ })).toBeUndefined()
    await ui.unmount()
  }
})
