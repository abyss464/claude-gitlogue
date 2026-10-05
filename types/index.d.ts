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
  // Shown in place of line counts, as a download's size.
  note?: string
}

export type GitlogueLink = { title: string; url: string }

// The editor's area as a browser: the address, what the page is (a search
// home, a results page, a fetched page), what has been typed into its box,
// the results shown so far and the one selected, the page's text and how far
// down it is read, and how far the page has loaded.
export type GitlogueBrowser = {
  url: string
  page: 'home' | 'results' | 'page'
  query: string
  results: GitlogueLink[]
  shown: number
  selected: number
  stats: string
  body: string[]
  scroll: number
  loading: number
  // Where typing goes: the search box or the address bar.
  focus?: 'box' | 'address'
}

// The editor's area as an image viewer: the picture shown and its size.
export type GitlogueImage = { path: string; png: string; width: number; height: number }

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
  | { type: 'search'; query: string; results: GitlogueLink[]; durationMs: number }
  | { type: 'fetch'; url: string; text: string; durationMs: number }
  | { type: 'image'; path: string; file: string; png: string; width: number; height: number; place?: GitloguePlace }
  | { type: 'download'; path: string; file: string; bytes: number; durationMs: number; place?: GitloguePlace }

// One row of the terminal pane, as Claude meets a shell: the turn it belongs
// to, what a command is for, the command, what came back, the files it wrote,
// and how the turn ended.
export type GitlogueTermLine = {
  kind: 'rule' | 'intent' | 'command' | 'output' | 'more' | 'edit' | 'done' | 'fail' | 'prompt' | 'progress'
  text: string
  // Drawn flush right: a command's time and status, an edit's line counts.
  right?: string
  ok?: boolean
  // The first line of a result, drawn under the ⎿ mark.
  first?: boolean
  // How far a download has come, 0 to 1.
  fraction?: number
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
  screen?: 'code' | 'browser' | 'image'
  browser?: GitlogueBrowser
  image?: GitlogueImage
}

// `session` names the session the replay belongs to, where it is recorded.
export type GitlogueSaved = { view: GitlogueView; pending: GitlogueEvent[]; session?: string }

declare module 'claude-code' {
  interface PluginState {
    gitlogue: { saved: GitlogueSaved }
  }
}
