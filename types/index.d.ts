// What the gitlogue mod keeps in the session's state, so a reload (an edit to
// the mod, a changed option) picks the replay up where it stood.

export type GitlogueTurn = { id: string; date: string; prompt: string }

// `turn` is the id of the turn that last changed the file; `file` its
// absolute path, where the explorer shows it.
export type GitlogueFileEntry = {
  path: string
  status: '+' | '~'
  added: number
  deleted: number
  turn?: string
  file?: string
}

// One entry of a directory as the explorer lists it.
export type GitlogueDirEntry = { name: string; dir: boolean }

// Where a changed file sits: the workspace it belongs to (its repository, or
// the session's folder) and the listing of each directory from there down.
export type GitloguePlace = { root: string; listings: Record<string, GitlogueDirEntry[]> }

// The file explorer: its workspace roots, the folders opened, what each
// listed, and the row the selection is on; paths are absolute.
export type GitlogueExplorer = {
  roots: string[]
  expanded: string[]
  listings: Record<string, GitlogueDirEntry[]>
  selected: string | null
}

export type GitlogueEvent =
  | { type: 'turn'; turn: GitlogueTurn }
  | { type: 'edit'; path: string; before: string; after: string; created: boolean; file?: string; place?: GitloguePlace }
  | { type: 'command'; command: string; description?: string }
  | { type: 'output'; lines: string[]; total: number; failed: boolean; exitCode?: number; durationMs: number }
  | { type: 'done'; durationMs: number; aborted: boolean }

// One row of the terminal pane, as Claude meets a shell: the turn it belongs
// to, what a command is for, the command, what came back, the files it wrote,
// and how the turn ended.
export type GitlogueTermLine = {
  kind: 'rule' | 'intent' | 'command' | 'output' | 'more' | 'edit' | 'done' | 'fail' | 'prompt'
  text: string
  // Drawn flush right: a command's time and status, an edit's line counts.
  right?: string
  ok?: boolean
  // The first line of a result, drawn under the ⎿ mark.
  first?: boolean
}

// The panes as they stood when the oldest unfinished event began.
export type GitlogueView = {
  lines: string[]
  cursorLine: number
  cursorCol: number
  active: 'editor' | 'terminal' | 'explorer'
  hasFile: boolean
  isBlank: boolean
  terminal: GitlogueTermLine[]
  turn: GitlogueTurn | null
  files: GitlogueFileEntry[]
  currentPath: string | null
  explorer?: GitlogueExplorer
}

// `session` names the session the replay belongs to, where it is recorded.
export type GitlogueSaved = { view: GitlogueView; pending: GitlogueEvent[]; session?: string }

declare module 'claude-code' {
  interface PluginState {
    gitlogue: { saved: GitlogueSaved }
  }
}
