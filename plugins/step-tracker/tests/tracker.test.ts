import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Activity, Job, Step } from '../types'

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
    job: () => state.job as Job | null | undefined,
    history: () => (state.history ?? []) as Job[],
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

test('a new turn archives the previous job into history and starts the new job empty', async ($, on) => {
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
  expect(w.steps()).toEqual([])
  expect(w.job()).toMatchObject({ id: 'turn-2', prompt: 'again' })
  expect(w.history()).toHaveLength(1)
  expect(w.history()[0]?.steps.map(s => s.title)).toEqual(['Open'])

  await $.tool.call({ tool: 'TaskCreate', subject: 'Second', description: 'x' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: 't-Second', status: 'completed' })
  await $.turn.complete({ turnId: 'turn-2', answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' })
  expect(w.phase()).toBe('yours')
  expect(w.steps().map(s => s.title)).toEqual(['Second'])

  await $.turn.start({ text: '  a much longer prompt   with spaces  ', turnId: 'turn-3' })
  expect(w.steps()).toEqual([])
  expect(w.job()?.prompt).toBe('a much longer prompt with spaces')
  expect(w.history().map(j => j.prompt)).toEqual(['', 'again'])
  expect(w.history()[1]?.steps[0]).toMatchObject({ title: 'Second', status: 'completed' })

  await $.turn.start({ text: 'nothing recorded last time', turnId: 'turn-4' })
  expect(w.history()).toHaveLength(2)
})

test('the band names the current job and the history pane lists previous ones', async ($, on) => {
  const w = world(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))

  await $.turn.start({ text: 'first job', turnId: 'j1' })
  await callAny($, { tool: 'mcp__step-tracker__plan', steps: [{ title: 'Alpha' }, { title: 'Beta' }] })
  await callAny($, { tool: 'mcp__step-tracker__step', index: 1, status: 'completed' })
  await $.turn.start({ text: 'second job', turnId: 'j2' })
  await callAny($, { tool: 'mcp__step-tracker__plan', steps: [{ title: 'Gamma' }] })
  expect(w.history()).toHaveLength(1)

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    expect(await band.find({ type: 'Text', text: /second job/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Gamma/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Alpha/ })).toBeUndefined()
    await band.unmount()

    const pane = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE, requestId: 'steps-history' })
    expect(await pane.find({ type: 'Text', text: /first job/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /1\/2 done/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Alpha/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Gamma/ })).toBeUndefined()
    await pane.unmount()
  }
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

test('a turn that ends with steps open says it is your turn, in the frame and the status line', async ($, on) => {
  const w = world(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'set it up', turnId: 'y1' })
  await callAny($, {
    tool: 'mcp__step-tracker__plan',
    steps: [{ title: 'Write config' }, { title: 'Log in', activeForm: 'Logging in' }, { title: 'Deploy' }],
  })
  await callAny($, { tool: 'mcp__step-tracker__step', index: 1, status: 'completed' })
  await callAny($, { tool: 'mcp__step-tracker__step', index: 2, status: 'in_progress' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /your turn/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Logging in/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete({ turnId: 'y1', answer: 'run the login yourself', durationMs: 10, isAborted: false, reason: 'answer' })
  expect(w.phase()).toBe('yours')
  expect(w.status.at(-1)).toBe('steps: 1/3 Log in · your turn')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND, props: { ...BAND.props, isWorking: false } })
    expect(await ui.find({ type: 'Text', text: /· your turn/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Claude has stopped, 2 steps left open/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⏸ 2\. Log in/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /waiting for you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Logging in/ })).toBeUndefined()
    await ui.unmount()
  }

  await $.turn.start({ text: 'done, go on', turnId: 'y2' })
  expect(w.phase()).toBe('working')
  expect(w.status.at(-1)).not.toContain('your turn')
})

test("an interrupted turn and an AskUserQuestion call are the person's move too", async ($, on) => {
  const w = world(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  let during: string | undefined
  on('tool.call', { tool: /^AskUserQuestion$/ }, () => {
    during = w.phase()
    return { result: 'yes' }
  })

  await $.turn.start({ text: 'ask me', turnId: 'q1' })
  await callAny($, { tool: 'mcp__step-tracker__plan', steps: [{ title: 'Ask' }, { title: 'Act' }] })
  await callAny($, { tool: 'AskUserQuestion', questions: [] })
  expect(during).toBe('waiting')
  expect(w.phase()).toBe('working')

  await $.turn.complete({ turnId: 'q1', answer: '', durationMs: 10, isAborted: true, reason: 'aborted' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND, props: { ...BAND.props, isWorking: false } })
    expect(await ui.find({ type: 'Text', text: /your turn · interrupted/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a subagent starting or ending mid-job keeps the job, its steps and its phase', async ($, on) => {
  const w = world(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'build it', turnId: 'm1' })
  await callAny($, { tool: 'mcp__step-tracker__plan', steps: [{ title: 'Explore' }, { title: 'Build' }] })
  await callAny($, { tool: 'mcp__step-tracker__step', index: 1, status: 'in_progress' })

  await $.turn.start({ text: 'search the code', turnId: 'a1', agentId: 'agent-1' })
  expect(w.steps().map(s => s.title)).toEqual(['Explore', 'Build'])
  expect(w.job()).toMatchObject({ id: 'm1', prompt: 'build it' })
  expect(w.history()).toEqual([])

  await $.turn.complete({ turnId: 'a1', agentId: 'agent-1', answer: 'found it', durationMs: 10, isAborted: false, reason: 'answer' })
  expect(w.phase()).not.toBe('yours')
  expect(w.steps()).toHaveLength(2)
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

test('a new prompt heads the band at once with an empty list; the old steps are reached with the arrows alone', async ($, on) => {
  const w = world(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'build it', turnId: 'b1' })
  await callAny($, { tool: 'mcp__step-tracker__plan', steps: [{ title: 'Alpha' }, { title: 'Beta' }] })
  await callAny($, { tool: 'mcp__step-tracker__step', index: 1, status: 'completed' })
  await callAny($, { tool: 'mcp__step-tracker__step', index: 2, status: 'completed' })
  await $.turn.complete({ turnId: 'b1', answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' })

  await $.turn.start({ text: 'is this intentional?', turnId: 'b2' })
  await $.turn.complete({ turnId: 'b2', answer: 'yes', durationMs: 10, isAborted: false, reason: 'answer' })
  expect(w.steps()).toEqual([])

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND, props: { ...BAND.props, isWorking: false } })
    expect(await band.find({ type: 'Text', text: /^Steps$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /· is this intentional\?/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /No steps recorded for this job yet/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /last job/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /Alpha/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /2\/2 done/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /2\/2/ })).toBeDefined()
    await band.press({ key: 'older' })
    expect(await band.find({ type: 'Text', text: /Job 1\/2/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Alpha/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /2\/2 done/ })).toBeDefined()
    await band.press({ key: 'newer' })
    await band.unmount()
  }

  await $.turn.start({ text: 'next build', turnId: 'b3' })
  await callAny($, { tool: 'mcp__step-tracker__plan', steps: [{ title: 'Gamma' }] })
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    expect(await band.find({ type: 'Text', text: /No steps recorded/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /Alpha/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /Gamma/ })).toBeDefined()
    await band.unmount()
  }
})

test('every submitted prompt carries the step-tracker reminder beside it, unseen by the person', async ($, on) => {
  world(on)
  // The engine beneath: the prompt enters with whatever context arrived.
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))

  const entered = await $.prompt.submit({ text: 'fix the build', wait: false, origin: { kind: 'composer' } })

  expect(entered.drop).toBeUndefined()
  expect(entered.text).toBe('fix the build')
  expect(entered.context).toHaveLength(1)
  expect(entered.context?.[0]).toMatch(/mcp__step-tracker__plan/)
})

test("a job's second tool call with no plan carries a reminder after its result; a planned job and a subagent get none", async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: /^mcp__demo__lookup$/ }, () => ({ result: { ok: true } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))

  await $.turn.start({ text: 'do a thing', turnId: 'r1' })
  const first = await callAny($, { tool: DEMO, query: 'one' })
  expect(first.context).toBeUndefined()
  const second = await callAny($, { tool: DEMO, query: 'two' })
  expect(second.deny).toBeUndefined()
  expect(second.context).toHaveLength(1)
  expect(second.context?.[0]).toMatch(/mcp__step-tracker__plan/)
  const third = await callAny($, { tool: DEMO, query: 'three' })
  expect(third.context).toBeUndefined()
  expect(w.activity()).toHaveLength(3)

  // A subagent's calls neither count nor get reminded.
  await $.turn.start({ text: 'delegated', turnId: 'r2' })
  const sub1 = await callAny($, { tool: DEMO, query: 'a', agentId: 'agent-1' })
  const sub2 = await callAny($, { tool: DEMO, query: 'b', agentId: 'agent-1' })
  expect(sub1.context).toBeUndefined()
  expect(sub2.context).toBeUndefined()
  const main1 = await callAny($, { tool: DEMO, query: 'c' })
  expect(main1.context).toBeUndefined()
  const main2 = await callAny($, { tool: DEMO, query: 'd' })
  expect(main2.context).toHaveLength(1)

  // A job that planned first is left alone.
  await $.turn.start({ text: 'planned', turnId: 'r3' })
  await callAny($, { tool: 'mcp__step-tracker__plan', steps: [{ title: 'Alpha' }, { title: 'Beta' }] })
  await callAny($, { tool: DEMO, query: 'e' })
  const planned = await callAny($, { tool: DEMO, query: 'f' })
  expect(planned.context).toBeUndefined()
})

test('the header shows an excerpt of the prompt, and a press on [more] shows the whole prompt', async ($, on) => {
  world(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))

  const long =
    'please refactor the authentication module so that every token check goes through one guard, then run the suite and push'
  await $.turn.start({ text: long, turnId: 'p1' })
  await callAny($, { tool: 'mcp__step-tracker__plan', steps: [{ title: 'Refactor' }, { title: 'Push' }] })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /please refactor the authentication module.*…$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /then run the suite and push/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', text: /more/ })).toBeDefined()

    await ui.press({ key: 'prompt' })
    expect(await ui.find({ type: 'Text', text: /then run the suite and push$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /less/ })).toBeDefined()

    await ui.press({ key: 'prompt' })
    expect(await ui.find({ type: 'Text', text: /then run the suite and push/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', text: /more/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the arrows in the header page back through previous jobs and forward to the live one', async ($, on) => {
  const w = world(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  const run = async (turnId: string, text: string, title: string) => {
    await $.turn.start({ text, turnId })
    await callAny($, { tool: 'mcp__step-tracker__plan', steps: [{ title }] })
    await callAny($, { tool: 'mcp__step-tracker__step', index: 1, status: 'completed' })
    await $.turn.complete({ turnId, answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' })
  }
  await run('h1', 'first prompt', 'Alpha')
  await run('h2', 'second prompt', 'Beta')
  await $.turn.start({ text: 'third prompt', turnId: 'h3' })
  await callAny($, { tool: 'mcp__step-tracker__plan', steps: [{ title: 'Gamma' }] })
  expect(w.history()).toHaveLength(2)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /^Steps$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Gamma/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /3\/3/ })).toBeDefined()

    await ui.press({ key: 'older' })
    expect(await ui.find({ type: 'Text', text: /Job 2\/3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Beta/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /second prompt/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /now: third prompt · 0\/1 done/ })).toBeDefined()

    await ui.press({ key: 'older' })
    expect(await ui.find({ type: 'Text', text: /Job 1\/3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Alpha/ })).toBeDefined()

    await ui.press({ key: 'older' })
    expect(await ui.find({ type: 'Text', text: /Job 1\/3/ })).toBeDefined()

    await ui.press({ key: 'newer' })
    expect(await ui.find({ type: 'Text', text: /Job 2\/3/ })).toBeDefined()
    await ui.press({ key: 'newer' })
    expect(await ui.find({ type: 'Text', text: /^Steps$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Gamma/ })).toBeDefined()
    await ui.unmount()
  }

  // A new prompt returns the band to the live job.
  await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND }).then(async ui => {
    await ui.press({ key: 'older' })
    await ui.unmount()
  })
  await $.turn.start({ text: 'fourth prompt', turnId: 'h4' })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^Steps$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· fourth prompt/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No steps recorded for this job yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Gamma/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /4\/4/ })).toBeDefined()
  await ui.press({ key: 'older' })
  expect(await ui.find({ type: 'Text', text: /Job 3\/4/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /now: fourth prompt · no steps recorded yet/ })).toBeDefined()
  await ui.press({ key: 'newer' })
  expect(await ui.find({ type: 'Text', text: /^Steps$/ })).toBeDefined()
  await ui.unmount()
})

test('a short prompt that fits the header row gets no [more] button', async ($, on) => {
  world(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))

  await $.turn.start({ text: 'fix it', turnId: 's1' })
  await callAny($, { tool: 'mcp__step-tracker__plan', steps: [{ title: 'Fix' }] })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /· fix it/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /more/ })).toBeUndefined()
    await ui.unmount()

    // The same prompt in a body too narrow for the row brings the button back.
    const narrow = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND, props: { ...BAND.props, bodyColumns: 20 } })
    expect(await narrow.find({ type: 'Button', text: /more/ })).toBeDefined()
    await narrow.unmount()
  }
})
