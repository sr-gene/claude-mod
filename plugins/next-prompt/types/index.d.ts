/** The places the guesses are shown, besides the dim text in the prompt box. */
export type UiMode = 'chips' | 'hint'

/** Where a candidate next prompt came from. */
export type CandidateSource = 'model' | 'engine'

export type Candidate = {
  text: string
  source: CandidateSource
}

/** One prompt the person sent, and what was offered before it. Kept in $.store. */
export type Sent = {
  /** The session's directory, so habits are read per project first. */
  cwd: string
  at: number
  /** What the person sent (capped). */
  text: string
  /** The candidates on offer when they sent it, best first. */
  offered: string[]
  /** Index into `offered` they sent as is, -1 when they typed something else. */
  taken: number
  /** True when they sent an offered candidate after editing it. */
  isEdited?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'next-prompt': {
      /** The candidates for the person's next prompt, best first; [] when none. */
      candidates: Candidate[]
      /** The main loop's last visible answer (its tail), for the next guess. */
      lastAnswer: string
      /** Whether a guess is being made now. */
      isThinking: boolean
      /** What became of the last suggestion event, for /next when there are no guesses. */
      lastEvent: string
      /** Where the guesses are shown (from $.store, so /next ui sticks across sessions). */
      ui: UiMode[]
    }
  }
}
