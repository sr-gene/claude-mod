export type StepStatus = 'pending' | 'in_progress' | 'completed'

export type Step = {
  id: string
  title: string
  status: StepStatus
  activeForm?: string
}

export type Activity = {
  id: string
  tool: string
  detail: string
  agentId?: string
  startedAt: number
  isDone: boolean
  isError?: boolean
}

export type AgentRun = {
  id: string
  type: string
  description: string
  startedAt: number
}

/**
 * What the main loop is doing. `idle` before any turn; `yours` once a turn
 * has ended (the person's move); `waiting` while a tool waits on the person
 * (AskUserQuestion, ExitPlanMode).
 */
export type Phase = 'idle' | 'working' | 'thinking' | 'writing' | 'tool' | 'waiting' | 'yours'

/** Why the last main-loop turn ended, for the "your turn" line. */
export type EndReason = 'answer' | 'aborted' | 'refusal' | 'error'

/** One job: the prompt that started a turn and the steps recorded during it. */
export type Job = {
  id: string
  /** A one-line excerpt of the prompt, for the header row. */
  prompt: string
  /** The prompt as typed (capped), shown when the header is expanded. */
  fullPrompt?: string
  startedAt: number
  endedAt?: number
  steps: Step[]
}

declare module 'claude-code' {
  interface PluginState {
    'step-tracker': {
      steps: Step[]
      activity: Activity[]
      agents: AgentRun[]
      phase: Phase
      /** Why the last main-loop turn ended; null while one runs. */
      endReason: EndReason | null
      isBandHidden: boolean
      /** Whether the header shows the whole prompt instead of its excerpt. */
      isPromptExpanded: boolean
      /** The history job the band is browsing (an index into `history`), or null for the live job. */
      viewIndex: number | null
      job: Job | null
      history: Job[]
    }
  }
}
