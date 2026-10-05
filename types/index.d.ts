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
  // Committed since it changed: drawn settled, without the change mark.
  committed?: boolean
}

export type GitlogueLink = { title: string; url: string }

// One file's matches in a code search, each a line number and its text.
export type GitlogueHit = { path: string; matches: { line: number; text: string }[] }

// The sidebar's search view: the query typed so far, the files whose matches
// have come in, and how many of them show.
export type GitlogueSearch = { query: string; hits: GitlogueHit[]; shown: number; total: number }

// The quick-open palette: the pattern typed and the files it lists.
export type GitloguePalette = { text: string; items: string[]; shown: number }

// A file on its way to the trash: its row's name, where it started, how far
// along it is (0 to 1).
export type GitlogueFlight = { name: string; row: number; depth: number; t: number }

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
  | { type: 'command'; command: string; description?: string; startedAt?: number }
  | { type: 'output'; lines: string[]; total: number; failed: boolean; exitCode?: number; durationMs: number }
  | { type: 'done'; durationMs: number; aborted: boolean }
  | { type: 'search'; query: string; results: GitlogueLink[]; durationMs: number }
  | { type: 'fetch'; url: string; text: string; durationMs: number }
  | { type: 'image'; path: string; file: string; png: string; width: number; height: number; place?: GitloguePlace }
  | { type: 'download'; path: string; file: string; bytes: number; durationMs: number; place?: GitloguePlace }
  | { type: 'read'; path: string; file: string; text: string; startLine: number; numLines: number; place?: GitloguePlace }
  | { type: 'codesearch'; query: string; hits: GitlogueHit[]; total: number }
  | { type: 'findfiles'; pattern: string; files: string[] }
  | { type: 'git'; commit?: { sha: string; branch?: string; message?: string }; push?: { branch: string }; root?: string; durationMs: number }
  | { type: 'delete'; path: string; file: string; isDir: boolean; place?: GitloguePlace }
  | { type: 'cast'; screen: string; frames: string[]; fps: number; speed: number; seconds: number; width: number; height: number; remove: string[] }

// One row of the terminal pane, as Claude meets a shell: the turn it belongs
// to, what a command is for, the command, what came back, the files it wrote,
// and how the turn ended.
export type GitlogueTermLine = {
  kind: 'rule' | 'intent' | 'command' | 'output' | 'more' | 'edit' | 'done' | 'fail' | 'prompt' | 'progress' | 'commit' | 'trash' | 'cast'
  text: string
  // Drawn flush right: a command's time and status, an edit's line counts.
  right?: string
  ok?: boolean
  // The first line of a result, drawn under the ⎿ mark.
  first?: boolean
  // How far a download (or, with `up`, a push) has come, 0 to 1.
  fraction?: number
  up?: boolean
  // A command still running: when it started, in epoch milliseconds.
  startedAt?: number
  running?: boolean
  // A commit's id and branch.
  sha?: string
  branch?: string
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
  screen?: 'code' | 'browser' | 'image' | 'cast'
  browser?: GitlogueBrowser
  image?: GitlogueImage
  // Lines read with the highlighter: whole lines from `from` up to `line`,
  // and `line` itself up to `col`.
  marks?: { from: number; line: number; col: number }
  sidebar?: 'explorer' | 'search'
  search?: GitlogueSearch
  palette?: GitloguePalette
  flight?: GitlogueFlight
  trashed?: number
}

// `session` names the session the replay belongs to, where it is recorded.
export type GitlogueSaved = {
  view: GitlogueView
  pending: GitlogueEvent[]
  session?: string
  captures?: GitlogueCapture[]
  chat?: GitlogueChat
}
/** The phone's chat as kept; a chat kept in another format is read again from the session. */
export type GitlogueChat = { format: number; lines: GitlogueChatLine[] }
/** A line of the phone's chat; `isRead` marks one of the person's that reached Claude. */
export type GitlogueChatLine = { role: 'me' | 'claude'; text: string; time?: string; isRead?: boolean }
/** Where and when a command left screen captures. */
export type GitlogueCapture = { dirs: string[]; from: number; to: number }

declare module 'claude-code' {
  interface PluginState {
    gitlogue: { saved: GitlogueSaved }
  }
}
