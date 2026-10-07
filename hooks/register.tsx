import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Activity, AgentRun, Phase, Step } from '../types'

const PANE = 'steps'
const KEEP_ACTIVITY = 40
const SHOW_ACTIVITY = 5

const steps = atom({ plugin: 'step-tracker', key: 'steps' } as const, [])
const activity = atom({ plugin: 'step-tracker', key: 'activity' } as const, [])
const agents = atom({ plugin: 'step-tracker', key: 'agents' } as const, [])
const phase = atom({ plugin: 'step-tracker', key: 'phase' } as const, 'idle')
const isBandHidden = atom({ plugin: 'step-tracker', key: 'isBandHidden' } as const, false)

/** The mod's own tools, as the model calls them. Matched by RegExp: the
 * engine lays its tool-name union before these are registered. */
const PLAN_TOOL = 'mcp__step-tracker__plan'
const STEP_TOOL = 'mcp__step-tracker__step'
const PLAN_MATCH = /^mcp__step-tracker__plan$/
const STEP_MATCH = /^mcp__step-tracker__step$/

/** Tools whose calls are the step list itself, not activity worth listing. */
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite', PLAN_TOOL, STEP_TOOL])

/** Which argument of a tool says what it is doing, first match wins. */
const DETAIL_KEYS: Record<string, readonly string[]> = {
  Bash: ['description', 'command'],
  PowerShell: ['description', 'command'],
  Edit: ['file_path'],
  Write: ['file_path'],
  Read: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Grep: ['pattern'],
  Glob: ['pattern'],
  Agent: ['description'],
  Skill: ['skill'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  ToolSearch: ['query'],
}

const NUDGE_OWN = [
  '# Step tracker',
  'The user watches a live pane that lists your steps. Whenever a request takes more than one step',
  '(two or more distinct actions), before doing any of them call mcp__step-tracker__plan with every step,',
  'in order, each with a short `title` and an `activeForm` in present continuous form (for example "Running tests").',
  'As you work, call mcp__step-tracker__step to set a step `in_progress` when you start it and `completed`',
  'when it is done, keeping exactly one step in_progress at a time. If the plan grows, call',
  'mcp__step-tracker__plan again with the full new list. For a single-step request, skip this.',
].join('\n')

const NUDGE_TASKS = [
  '# Step tracker',
  'The user watches a live pane that lists your steps. Whenever a request takes more than one step',
  '(two or more distinct actions), before doing any of them call TaskCreate once per step, in order,',
  'each with a short `subject` and an `activeForm` in present continuous form (for example "Running tests").',
  'As you work, call TaskUpdate to set a step `in_progress` when you start it and `completed` when it is done,',
  'keeping exactly one step in_progress at a time. If the plan grows, add the new steps with TaskCreate.',
  'For a single-step request, skip this.',
].join('\n')

const NUDGE_TODO = [
  '# Step tracker',
  'The user watches a live pane that lists your steps. Whenever a request takes more than one step',
  '(two or more distinct actions), before doing any of them call TodoWrite with every step, each with',
  'an `activeForm` in present continuous form (for example "Running tests"). Call TodoWrite again whenever',
  'a step starts (`in_progress`) or finishes (`completed`), keeping exactly one step in_progress at a time.',
  'For a single-step request, skip this.',
].join('\n')

const STATUSES = new Set<Step['status']>(['pending', 'in_progress', 'completed'])

/** The text a plan or step call answers the model with. */
function describeSteps(list: Step[]): string {
  if (list.length === 0) return 'No steps recorded.'
  const mark = (s: Step) => (s.status === 'completed' ? '[x]' : s.status === 'in_progress' ? '[>]' : '[ ]')
  return list.map((s, i) => `${mark(s)} ${i + 1}. ${s.title}`).join('\n')
}

/** A registered tool's result is a string (or an array of blocks); the engine refuses an object. */
function toolText(text: string) {
  return { result: text }
}

function detailOf(e: { tool: string } & Record<string, unknown>): string {
  const keys = DETAIL_KEYS[String(e.tool)] ?? []
  for (const key of keys) {
    const value = e[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim().replace(/\s+/g, ' ').slice(0, 120)
    }
  }
  return ''
}

function shortTool(tool: string): string {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool)
  return mcp ? `${mcp[1]}:${mcp[2]}` : tool
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'idle',
  working: 'working',
  thinking: 'thinking',
  writing: 'writing a reply',
  tool: 'calling a tool',
}

async function refreshStatus($: EngineInterface): Promise<void> {
  const list = await read($, steps)
  const acts = await read($, activity)
  const now = await read($, phase)
  const done = list.filter(s => s.status === 'completed').length
  const current = list.find(s => s.status === 'in_progress')
  const running = [...acts].reverse().find(a => !a.isDone)

  const parts: string[] = []
  if (list.length > 0) {
    parts.push(`${done}/${list.length}${current ? ` ${current.title}` : ''}`)
  }
  if (running) {
    parts.push(`${shortTool(running.tool)}${running.detail ? ` ${running.detail.slice(0, 48)}` : ''}`)
  } else if (now !== 'idle') {
    parts.push(PHASE_LABEL[now])
  }

  $.ui.status(parts.length > 0 ? `steps: ${parts.join(' · ')}` : undefined)
}

async function noteAgent($: EngineInterface, agentId: string): Promise<void> {
  const known = await read($, agents)
  if (known.some(a => a.id === agentId)) return
  const list = await $.agent.list()
  const info = list.find(a => a.id === agentId)
  const run: AgentRun = {
    id: agentId,
    type: info?.type ?? 'agent',
    description: info?.description ?? '',
    startedAt: await $.clock.now(),
  }
  await update($, agents, l => (l.some(a => a.id === agentId) ? l : [...l, run]))
}

type Table = Pick<Elements[RenderSurface], 'Box' | 'Text'>

/** The tracker as drawn in the band above the prompt and in the pane alike. */
async function drawTracker($: EngineInterface, { Box, Text }: Table) {
  const list = await read($, steps)
  const acts = await read($, activity)
  const runs = await read($, agents)
  const now = await read($, phase)

  const done = list.filter(s => s.status === 'completed').length
  const recent = acts.slice(-SHOW_ACTIVITY)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
      <Box>
        <Text bold>Steps</Text>
        <Text dimColor>{list.length > 0 ? `  ${done}/${list.length} done` : ''}</Text>
      </Box>

      {list.length === 0 && (
        <Text dimColor wrap="wrap">
          No steps yet. Claude lists them here when a job takes more than one.
        </Text>
      )}

      {list.map((step, i) => (
        <Box key={step.id} flexDirection="column">
          <Text
            wrap="truncate-end"
            bold={step.status === 'in_progress'}
            dimColor={step.status === 'completed'}
            color={step.status === 'in_progress' ? 'claude' : step.status === 'completed' ? 'success' : undefined}
          >
            {step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '▶' : '○'} {i + 1}. {step.title}
          </Text>
          {step.status === 'in_progress' && step.activeForm && (
            <Text dimColor wrap="truncate-end">
              {'     '}{step.activeForm}…
            </Text>
          )}
        </Box>
      ))}

      <Box marginTop={1}>
        <Text bold>Now</Text>
        <Text dimColor> {PHASE_LABEL[now]}</Text>
      </Box>

      {runs.map(run => (
        <Text wrap="truncate-end" color="claude">
          {'  '}⟳ {run.type}{run.description ? `: ${run.description}` : ''}
        </Text>
      ))}

      {recent.length === 0 && now === 'idle' && (
        <Text dimColor>{'  '}nothing running</Text>
      )}

      {recent.map(a => (
        <Text wrap="truncate-end" dimColor={a.isDone} color={a.isError ? 'error' : undefined}>
          {'  '}{a.isDone ? (a.isError ? '✗' : '·') : '▶'} {shortTool(a.tool)}
          {a.detail ? ` ${a.detail}` : ''}
          {a.agentId ? ' (agent)' : ''}
        </Text>
      ))}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'steps',
      description: 'Show the step tracker above the prompt; "/steps hide" hides it, "/steps pane" opens it as a pane, "/steps reset" clears it',
      argumentHint: '[hide|pane|reset]',
    })
    await $.tool.register({
      name: 'plan',
      description:
        'Record the ordered list of steps you will take for the current request, shown live to the user. ' +
        'Replaces any previous list. Each step has a short title and an activeForm (present continuous, e.g. "Running tests").',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: { title: { type: 'string' }, activeForm: { type: 'string' } },
              required: ['title'],
            },
          },
        },
        required: ['steps'],
      },
    })
    await $.tool.register({
      name: 'step',
      description:
        'Update one recorded step by its 1-based index: status in_progress when you start it, completed when done. ' +
        'Keep exactly one step in_progress at a time.',
      inputSchema: {
        type: 'object',
        properties: {
          index: { type: 'integer', minimum: 1 },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          title: { type: 'string' },
          activeForm: { type: 'string' },
        },
        required: ['index', 'status'],
      },
    })
    // The band is the default; a pane left open by an earlier load is closed here.
    await $.ui.close({ id: PANE })
    await refreshStatus($)

    return next(e)
  })

  on('command.run', { command: 'steps' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'reset') {
      await update($, steps, () => [])
      await update($, activity, () => [])
      await update($, agents, () => [])
      await refreshStatus($)
      return { text: 'Step tracker cleared.' }
    }
    if (arg === 'hide') {
      await update($, isBandHidden, () => true)
      await $.ui.close({ id: PANE })
      return { text: 'Step tracker hidden. /steps shows it again.' }
    }
    if (arg === 'pane') {
      const opened = await $.ui.open({ id: PANE, title: 'Steps' })
      return { text: opened.isPlaced ? 'Step tracker pane opened.' : `Step tracker pane waiting: ${opened.reason}` }
    }
    await update($, isBandHidden, () => false)
    await $.ui.close({ id: PANE })
    return { text: 'Step tracker shown above the prompt.' }
  })

  // The nudge: ask Claude to record multi-step work with its task tools, so
  // the pane has something to show even for jobs it would otherwise just do.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const hasOwn = e.tools.includes(PLAN_TOOL) && e.tools.includes(STEP_TOOL)
    const hasTasks = e.tools.includes('TaskCreate') && e.tools.includes('TaskUpdate')
    const hasTodo = e.tools.includes('TodoWrite')
    const text = hasOwn ? NUDGE_OWN : hasTasks ? NUDGE_TASKS : hasTodo ? NUDGE_TODO : null
    if (text === null) return composed

    return { sections: [...composed.sections, { id: 'step-tracker', text, scope: 'session' }] }
  })

  // The mod's own tools: work on every build, whether or not TaskCreate exists.
  on('tool.call', { tool: PLAN_MATCH }, async ($, e) => {
    const raw = (e as unknown as Record<string, unknown>).steps
    if (!Array.isArray(raw)) return { deny: 'plan: `steps` must be an array of { title, activeForm? }.' }
    const list: Step[] = []
    for (const [i, item] of raw.entries()) {
      const rec = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
      const title = rec.title
      const activeForm = rec.activeForm
      if (typeof title !== 'string' || title.trim() === '') return { deny: `plan: step ${i + 1} has no title.` }
      list.push({
        id: `plan-${i + 1}`,
        title: title.trim(),
        status: 'pending',
        ...(typeof activeForm === 'string' && activeForm.trim() ? { activeForm: activeForm.trim() } : {}),
      })
    }
    await update($, steps, () => list)
    await refreshStatus($)

    return toolText(`Recorded ${list.length} step(s):\n${describeSteps(list)}`)
  })

  on('tool.call', { tool: STEP_MATCH }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const index = typeof input.index === 'number' ? Math.trunc(input.index) : NaN
    const status = input.status
    if (!Number.isInteger(index) || index < 1) return { deny: 'step: `index` must be a 1-based integer.' }
    if (typeof status !== 'string' || !STATUSES.has(status as Step['status'])) {
      return { deny: 'step: `status` must be pending, in_progress or completed.' }
    }
    const current = await read($, steps)
    if (index > current.length) return { deny: `step: there are only ${current.length} step(s); call plan first.` }
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : undefined
    const activeForm = typeof input.activeForm === 'string' && input.activeForm.trim() ? input.activeForm.trim() : undefined
    const list = await update($, steps, l =>
      l.map((s, i) =>
        i === index - 1
          ? { ...s, status: status as Step['status'], ...(title ? { title } : {}), ...(activeForm ? { activeForm } : {}) }
          : s,
      ),
    )
    await refreshStatus($)

    return toolText(describeSteps(list))
  })

  // Steps: Claude's own task tools are the source of truth.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const task = ran.deny === undefined && ran.isError !== true ? ran.result?.task : undefined
    if (task) {
      const step: Step = {
        id: task.id,
        title: e.subject,
        status: 'pending',
        ...(e.activeForm ? { activeForm: e.activeForm } : {}),
      }
      // A new task after a fully finished list starts a fresh list.
      await update($, steps, list => {
        const base = list.length > 0 && list.every(s => s.status === 'completed') ? [] : list
        return [...base.filter(s => s.id !== step.id), step]
      })
      await refreshStatus($)
    }

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const { taskId, subject, activeForm } = e
      const status = e.status === 'deleted' ? undefined : e.status
      await update($, steps, list =>
        e.status === 'deleted'
          ? list.filter(s => s.id !== taskId)
          : list.map(s =>
              s.id === taskId
                ? {
                    ...s,
                    title: subject ?? s.title,
                    status: status ?? s.status,
                    ...(activeForm ? { activeForm } : {}),
                  }
                : s,
            ),
      )
      await refreshStatus($)
    }

    return ran
  })

  on('tool.call', { tool: 'TaskList' }, async ($, e, next) => {
    const ran = await next(e)
    const tasks = ran.deny === undefined && ran.isError !== true ? ran.result?.tasks : undefined
    if (tasks) {
      await update($, steps, list => {
        const byId = new Map(list.map(s => [s.id, s] as const))
        return tasks.map(t => {
          const old = byId.get(t.id)
          return { id: t.id, title: t.subject, status: t.status, ...(old?.activeForm ? { activeForm: old.activeForm } : {}) }
        })
      })
      await refreshStatus($)
    }

    return ran
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await update($, steps, () =>
        e.todos.map((t, i) => ({
          id: `todo-${i}`,
          title: t.content,
          status: t.status,
          ...(t.activeForm ? { activeForm: t.activeForm } : {}),
        })),
      )
      await refreshStatus($)
    }

    return ran
  })

  // Activity: every other tool call, in the main loop or a subagent's.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (TASK_TOOLS.has(tool)) return next(e)

    const startedAt = await $.clock.now()
    const id = e.tool_use_id ?? `${tool}-${startedAt}`
    const item: Activity = {
      id,
      tool,
      detail: detailOf(e as { tool: string } & Record<string, unknown>),
      startedAt,
      isDone: false,
      ...(e.agentId ? { agentId: e.agentId } : {}),
    }
    await update($, activity, list => [...list, item].slice(-KEEP_ACTIVITY))
    if (e.agentId) await noteAgent($, e.agentId)
    await refreshStatus($)

    const ran = await next(e)

    const isError = ran.deny !== undefined || ran.isError === true
    await update($, activity, list =>
      list.map(a => (a.id === id ? { ...a, isDone: true, ...(isError ? { isError: true } : {}) } : a)),
    )
    await refreshStatus($)

    return ran
  })

  // Phase between tool calls: thinking, writing, or preparing a tool call.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)

    const stream = next(e)
    let current: Phase | null = null
    for await (const chunk of stream) {
      const next_: Phase | null =
        chunk.kind === 'thinking' ? 'thinking'
        : chunk.kind === 'text' ? 'writing'
        : chunk.kind === 'tool' || chunk.kind === 'input' ? 'tool'
        : null
      if (next_ !== null && next_ !== current) {
        current = next_
        try {
          await update($, phase, () => next_)
        } catch {
          // A missed phase write never interrupts the model's stream.
        }
      }
      yield chunk
    }

    return await stream.result
  })

  on('turn.start', async ($, e, next) => {
    // The last list stays on screen, finished or not, until the next plan replaces it.
    await update($, activity, () => [])
    await update($, agents, () => [])
    await update($, phase, () => 'working')
    await refreshStatus($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const gone = e.agentId
      await update($, agents, list => list.filter(a => a.id !== gone))
      return next(e)
    }
    await update($, phase, () => 'idle')
    await update($, activity, list => list.map(a => (a.isDone ? a : { ...a, isDone: true })))
    await refreshStatus($)

    return next(e)
  })

  // The bottom panel: the band directly above the prompt. Drawn while there is
  // something to show (steps, or a turn running); hidden by /steps hide or a survey.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, steps)
    const now = await read($, phase)
    const hidden = await read($, isBandHidden)
    const isQuiet = e.props.hasSurvey || hidden || (list.length === 0 && now === 'idle')
    if (isQuiet) return next(e)

    return drawTracker($, $.ui.resolve(e))
  })

  // The same tracker as a pane, for anyone who prefers a sidebar: /steps pane.
  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawTracker($, $.ui.resolve(e)))
}
