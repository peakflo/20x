import { create } from 'zustand'

export type SetupPhase =
  | 'installing'    // Installing OpenCode binary
  | 'starting'      // Starting OpenCode server
  | 'configuring'   // Creating agent & selecting model
  | 'done'          // All done
  | 'error'         // Something failed

interface SetupProgressState {
  /** Whether background setup is active */
  active: boolean
  /** Current phase label */
  phase: SetupPhase
  /** Human-readable status message */
  message: string
  /** 0–100 percent */
  percent: number
  /** Error message if phase === 'error' */
  errorMessage: string | null
  /** Whether the toast was dismissed by user */
  dismissed: boolean

  // Actions
  start: (message: string) => void
  update: (patch: Partial<Pick<SetupProgressState, 'phase' | 'message' | 'percent'>>) => void
  finish: (message: string) => void
  fail: (message: string) => void
  dismiss: () => void
  reset: () => void
}

export const useSetupProgressStore = create<SetupProgressState>((set) => ({
  active: false,
  phase: 'installing',
  message: '',
  percent: 0,
  errorMessage: null,
  dismissed: false,

  start: (message) =>
    set({ active: true, phase: 'installing', message, percent: 0, errorMessage: null, dismissed: false }),

  update: (patch) =>
    set((s) => ({ ...s, ...patch })),

  finish: (message) =>
    set({ phase: 'done', message, percent: 100 }),

  fail: (message) =>
    set({ phase: 'error', message, errorMessage: message, percent: 0 }),

  dismiss: () =>
    set({ dismissed: true }),

  reset: () =>
    set({ active: false, phase: 'installing', message: '', percent: 0, errorMessage: null, dismissed: false })
}))
