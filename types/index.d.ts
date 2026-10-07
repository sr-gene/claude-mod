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

export type Phase = 'idle' | 'working' | 'thinking' | 'writing' | 'tool'

declare module 'claude-code' {
  interface PluginState {
    'step-tracker': {
      steps: Step[]
      activity: Activity[]
      agents: AgentRun[]
      phase: Phase
      isBandHidden: boolean
    }
  }
}
