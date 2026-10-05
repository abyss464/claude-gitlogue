// What the gitlogue mod keeps in the session's state, so a reload (an edit to
// the mod, a changed option) picks the replay up where it stood.

export type GitlogueTurn = { id: string; date: string; prompt: string }

export type GitlogueFileEntry = { path: string; status: '+' | '~'; added: number; deleted: number }

export type GitlogueEvent =
  | { type: 'turn'; turn: GitlogueTurn }
  | { type: 'edit'; path: string; before: string; after: string; created: boolean }
  | { type: 'command'; command: string }
  | { type: 'output'; lines: string[]; failed: boolean }
  | { type: 'done'; durationMs: number; aborted: boolean }

// The panes as they stood when the oldest unfinished event began.
export type GitlogueView = {
  lines: string[]
  cursorLine: number
  cursorCol: number
  active: 'editor' | 'terminal'
  hasFile: boolean
  isBlank: boolean
  terminal: string[]
  turn: GitlogueTurn | null
  files: GitlogueFileEntry[]
  currentPath: string | null
}

export type GitlogueSaved = { view: GitlogueView; pending: GitlogueEvent[] }

declare module 'claude-code' {
  interface PluginState {
    gitlogue: { saved: GitlogueSaved }
  }
}
