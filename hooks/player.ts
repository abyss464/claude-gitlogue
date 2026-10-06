// The playback engine: Claude's work arrives as events (a turn begins, a file
// changes, a command runs, the turn ends), each becomes a script of small steps
// the way gitlogue scripts a commit, and `advance` plays the script against the
// clock. Pacing constants are gitlogue's, as multiples of the typing speed.

import type {
  GitlogueBrowser,
  GitlogueEvent,
  GitlogueFlight,
  GitlogueImage,
  GitloguePalette,
  GitlogueSearch,
  GitlogueFileEntry,
  GitloguePlace,
  GitlogueSaved,
  GitlogueTermLine,
  GitlogueTurn,
  GitlogueView,
} from '../types'
import { countChanges, diffLines, type Hunk } from './diff'
import { chainTo, Explorer, nameOf, parentOf, type DirEntry } from './explorer'
import { cellText } from './cells'
import { words } from './i18n'
import { Highlighter } from './highlight'

const CURSOR_MOVE_PAUSE = 0.5
const CURSOR_MOVE_SHORT_MULTIPLIER = 1.0
const CURSOR_MOVE_MEDIUM_MULTIPLIER = 0.3
const CURSOR_MOVE_LONG_MULTIPLIER = 0.05
const MAX_SCROLL_STEPS = 60
const MIN_LOG_STEPS = 50
const LOG_SCALE_FACTOR = 8.0
const DELETE_LINE_PAUSE = 10.0
const INSERT_LINE_PAUSE = 6.7
const HUNK_PAUSE = 50.0
const CHECKOUT_PAUSE = 16.7
const CHECKOUT_OUTPUT_PAUSE = 33.3
const OPEN_FILE_FIRST_PAUSE = 33.3
const OPEN_FILE_PAUSE = 50.0
const OPEN_CMD_PAUSE = 16.7
const FILE_SWITCH_PAUSE = 26.7
const GIT_ADD_PAUSE = 33.3
const GIT_ADD_CMD_PAUSE = 16.7
const PUSH_OUTPUT_PAUSE = 10.0

const MAX_TERMINAL_LINES = 300
const EXPAND_PAUSE = 6.0
const SELECT_STEP_PAUSE = 1.5
const PAGE_LOAD_STEPS = 18
const MAX_READ_SWEEP = 120
const FLY_STEPS = 16
const DOWNLOAD_STEPS = 28

type Screen = 'code' | 'browser' | 'image' | 'cast'

// A recording of one of Claude's own screens, as it plays.
export type Cast = { screen: string; width: number; height: number; speed: number; seconds: number }

const EMPTY_BROWSER: GitlogueBrowser = {
  url: '',
  page: 'home',
  query: '',
  results: [],
  shown: 0,
  selected: -1,
  stats: '',
  body: [],
  scroll: 0,
  loading: 1,
}
// Past these a change is a machine's output, not something typed: it is
// counted in the tree and noted in the terminal, never replayed key by key.
const MAX_TYPED_LINE = 1000
const MAX_TYPED_CHARS = 100_000
const LOCK_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'uv.lock',
  'Pipfile.lock', 'Gemfile.lock', 'composer.lock', 'go.sum', 'flake.lock', 'mix.lock', 'pubspec.lock',
])

export type TurnInfo = GitlogueTurn
export type FileEntry = GitlogueFileEntry
export type PlayerEvent = GitlogueEvent
export type TermLine = GitlogueTermLine

type FileChange = { path: string; oldLines: string[]; entry: FileEntry }

type StepBody =
  | { k: 'char'; line: number; col: number; ch: string }
  | { k: 'backspace'; line: number; col: number }
  | { k: 'insertLine'; line: number; text: string }
  | { k: 'deleteLine'; line: number }
  | { k: 'move'; line: number; col: number }
  | { k: 'pause' }
  | { k: 'switchFile'; change: FileChange }
  | { k: 'count'; entry: FileEntry }
  | { k: 'root'; root: string }
  | { k: 'list'; dir: string; entries: DirEntry[]; ensure?: DirEntry }
  | { k: 'expand'; dir: string }
  | { k: 'select'; path: string }
  | { k: 'screen'; screen: Screen }
  | { k: 'browse'; set: Partial<GitlogueBrowser> }
  | { k: 'boxChar'; ch: string }
  | { k: 'addressChar'; ch: string }
  | { k: 'image'; image: GitlogueImage }
  | { k: 'progress'; fraction: number; right?: string }
  | { k: 'mark'; from: number; line: number; col: number }
  | { k: 'sidebar'; sidebar: 'explorer' | 'search' }
  | { k: 'search'; set: Partial<GitlogueSearch> }
  | { k: 'searchChar'; ch: string }
  | { k: 'palette'; set: Partial<GitloguePalette> | null }
  | { k: 'paletteChar'; ch: string }
  | { k: 'termRunning' }
  | { k: 'commitMark'; root: string }
  | { k: 'flyStart'; file: string }
  | { k: 'fly'; t: number }
  | { k: 'trash'; file: string }
  | { k: 'castStart'; cast: Cast }
  | { k: 'castFrame'; file: string }
  | { k: 'castEnd'; remove: string[] }
  | { k: 'dialogOpen' }
  | { k: 'dialogChar'; ch: string }
  | { k: 'termLine'; line: TermLine }
  | { k: 'termChar'; ch: string }
  | { k: 'termResult'; right: string; ok: boolean }
  | { k: 'termDone'; durationMs: number; aborted: boolean }
  | { k: 'resetTurn'; turn: TurnInfo }

type Step = StepBody & { dur: number }

const splitLines = (text: string) => (text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/).map(cellText))
const indentOf = (line: string | undefined) => (line ?? '').length - (line ?? '').trimStart().length

export class Player {
  // What the panes draw.
  lines: string[] = ['']
  cursorLine = 0
  cursorCol = 0
  active: 'editor' | 'terminal' | 'explorer' = 'terminal'
  hasFile = false
  terminal: TermLine[] = []
  // The word Claude Code closed a turn of this length with (`Cogitated`), when known.
  wordFor: (durationMs: number) => string | undefined = () => undefined
  dialog: { title: string; text: string } | undefined
  turn: TurnInfo | undefined
  files = new Map<string, FileEntry>()
  currentPath: string | undefined
  readonly highlighter = new Highlighter()
  // Bumped whenever the turn shown changes, for the drawing that shows it.
  turnVersion = 0

  // The explorer the panes draw, and the copy the script walks ahead on.
  explorer = new Explorer()
  // What the editor's area shows: code, a browser, or a picture.
  screen: Screen = 'code'
  browser: GitlogueBrowser = { ...EMPTY_BROWSER }
  image: GitlogueImage | undefined
  // Lines read with the highlighter, the sidebar's view, the quick-open
  // palette, a file on its way to the trash, and how many went there.
  marks: { from: number; line: number; col: number } | undefined
  sidebar: 'explorer' | 'search' = 'explorer'
  search: GitlogueSearch | undefined
  palette: GitloguePalette | undefined
  flight: GitlogueFlight | undefined
  trashed = 0
  // A screen recording playing in the editor's area, its current frame, and
  // the files played through, for the pane to delete.
  cast: Cast | undefined
  castFrame: string | undefined
  removals: string[] = []
  private planSidebar: 'explorer' | 'search' = 'explorer'
  // Bumped when the screen or its picture changes, for the drawing that holds it.
  sceneVersion = 0
  private planScreen: Screen = 'code'
  private planBrowser: GitlogueBrowser = { ...EMPTY_BROWSER }
  private plan = new Explorer()
  private planKeep = new Set<string>()
  // A file that starts empty shows one blank line, which its first typed line takes over.
  private isBlank = false
  private steps: Step[] = []
  private next = 0
  // Absolute index of steps[0], so event boundaries survive compaction.
  private base = 0
  // Events not yet fully played, each with the absolute step index it ends at,
  // and the panes as they stood when the oldest of them began.
  private segments: { event: PlayerEvent; end: number }[] = []
  private checkpoint: GitlogueView = this.view()
  // Bumped whenever what `save` returns changes.
  saveVersion = 0
  private wait = 0
  private remaining = 0
  private filesThisTurn = 0
  // The file the script last left in the editor, and its text then.
  private scriptedPath: string | undefined
  private scriptedText: string | undefined

  private readonly speedMs: number
  private readonly maxLagMs: number

  constructor(speedMs: number, maxLagMs: number) {
    this.speedMs = speedMs
    this.maxLagMs = maxLagMs
  }

  // A command still running at the bottom of the terminal.
  get hasRunning(): boolean {
    return this.terminal.some(line => line.kind === 'command' && line.running === true)
  }

  get isIdle(): boolean {
    return this.next >= this.steps.length
  }

  enqueue(event: PlayerEvent) {
    this.script(event)
    this.segments.push({ event, end: this.base + this.steps.length })
    this.saveVersion++
    this.settle()
  }

  // The replay as it stands: the panes at the oldest unfinished event, and the
  // events from there on, to pick up after a reload.
  save(): GitlogueSaved {
    // A recording's frames do not outlive this load: it is not kept to replay.
    return { view: this.checkpoint, pending: this.segments.map(segment => segment.event).filter(event => event.type !== 'cast') }
  }

  restore(saved: GitlogueSaved) {
    const view = saved.view
    this.lines = view.lines.length > 0 ? view.lines.slice() : ['']
    this.cursorLine = view.cursorLine
    this.cursorCol = view.cursorCol
    this.active = view.active
    this.hasFile = view.hasFile
    this.isBlank = view.isBlank
    // Records from before the terminal had structure hold plain strings.
    this.terminal = view.terminal.map(line =>
      typeof line === 'string' ? { kind: 'output' as const, text: line } : { ...line },
    )
    this.turn = view.turn ?? undefined
    this.files = new Map(view.files.map(entry => [entry.path, { ...entry }]))
    this.currentPath = view.currentPath ?? undefined
    this.explorer = Explorer.from(view.explorer)
    this.screen = view.screen === 'cast' ? 'code' : (view.screen ?? 'code')
    this.browser = view.browser ? { ...view.browser, results: view.browser.results.slice(), body: view.browser.body.slice() } : { ...EMPTY_BROWSER }
    this.image = view.image ? { ...view.image } : undefined
    this.marks = view.marks ? { ...view.marks } : undefined
    this.sidebar = view.sidebar ?? 'explorer'
    this.planSidebar = this.sidebar
    this.search = view.search ? { ...view.search, hits: view.search.hits.slice() } : undefined
    this.palette = undefined
    this.flight = undefined
    this.trashed = view.trashed ?? 0
    this.planScreen = this.screen
    this.planBrowser = { ...this.browser }
    this.sceneVersion++
    this.plan = this.explorer.clone()
    this.planKeep = new Set(view.files.flatMap(entry => (entry.file ? [entry.file] : [])))
    this.dialog = undefined
    if (view.hasFile && view.currentPath) this.highlighter.setPath(view.currentPath)
    this.turnVersion++
    this.steps = []
    this.next = 0
    this.base = 0
    this.wait = 0
    this.remaining = 0
    this.segments = []
    this.filesThisTurn = view.files.length
    this.scriptedPath = view.hasFile ? (view.currentPath ?? undefined) : undefined
    this.scriptedText = view.lines.join('\n')
    this.checkpoint = this.view()
    this.saveVersion++
    for (const event of saved.pending) this.enqueue(event)
  }

  private setScreen(screen: Screen) {
    if (this.screen === screen) return
    this.screen = screen
    this.sceneVersion++
  }

  // A new row, taking the place of an idle prompt left at the bottom.
  private addLine(line: TermLine) {
    if (this.terminal[this.terminal.length - 1]?.kind === 'prompt') this.terminal.pop()
    this.terminal.push(line)
  }

  // Back to an empty pane, as a session with nothing replayed yet.
  reset() {
    this.restore({
      view: {
        lines: [''],
        cursorLine: 0,
        cursorCol: 0,
        active: 'terminal',
        hasFile: false,
        isBlank: false,
        terminal: [],
        turn: null,
        files: [],
        currentPath: null,
      },
      pending: [],
    })
  }

  view(): GitlogueView {
    return {
      lines: this.lines.slice(),
      cursorLine: this.cursorLine,
      cursorCol: this.cursorCol,
      active: this.active,
      hasFile: this.hasFile,
      isBlank: this.isBlank,
      terminal: this.terminal.map(line => ({ ...line })),
      turn: this.turn ?? null,
      files: [...this.files.values()].map(entry => ({ ...entry })),
      currentPath: this.currentPath ?? null,
      explorer: this.explorer.save(),
      screen: this.screen,
      browser: { ...this.browser, results: this.browser.results.slice(), body: this.browser.body.slice() },
      image: this.image ? { ...this.image } : undefined,
      marks: this.marks ? { ...this.marks } : undefined,
      sidebar: this.sidebar,
      search: this.search ? { ...this.search, hits: this.search.hits.slice() } : undefined,
      trashed: this.trashed,
    }
  }

  // Retires the events whose steps have all run.
  private settle() {
    let moved = false
    while (this.segments.length > 0 && this.segments[0].end <= this.base + this.next) {
      this.segments.shift()
      moved = true
    }
    if (moved) {
      this.checkpoint = this.view()
      this.saveVersion++
    }
  }

  private script(event: PlayerEvent) {
    const before = this.steps.length
    switch (event.type) {
      case 'turn':
        this.scriptTurn(event.turn)
        break
      case 'edit':
        this.scriptEdit(event)
        break
      case 'command':
        // The intent arrives whole, as a thought does; the command is typed.
        if (event.description?.trim()) {
          this.push({ k: 'termLine', line: { kind: 'intent', text: event.description.trim() } })
          this.pause(OPEN_CMD_PAUSE)
        }
        this.push({ k: 'termLine', line: { kind: 'command', text: '', startedAt: event.startedAt } })
        for (const ch of cellText(event.command.replace(/\s*\n\s*/g, ' ; ')).slice(0, 240)) this.push({ k: 'termChar', ch }, this.typing())
        this.push({ k: 'termRunning' }, 0)
        this.pause(GIT_ADD_CMD_PAUSE)
        break
      case 'output': {
        const status = event.failed ? (event.exitCode ? `✗ ${event.exitCode}` : '✗') : '✓'
        this.push({ k: 'termResult', right: `${formatDuration(event.durationMs, true)} ${status}`, ok: !event.failed })
        event.lines.forEach((text, i) => this.push({ k: 'termLine', line: { kind: 'output', text, first: i === 0 } }, this.speedMs / 2))
        if (event.total > event.lines.length)
          this.push({ k: 'termLine', line: { kind: 'more', text: words.moreLines(event.total - event.lines.length) } })
        this.pause(PUSH_OUTPUT_PAUSE)
        break
      }
      case 'search':
        this.scriptSearch(event)
        break
      case 'fetch':
        this.scriptFetch(event)
        break
      case 'image':
        this.scriptImage(event)
        break
      case 'download':
        this.scriptDownload(event)
        break
      case 'read':
        this.scriptRead(event)
        break
      case 'codesearch':
        this.scriptCodeSearch(event)
        break
      case 'findfiles':
        this.scriptFindFiles(event)
        break
      case 'git':
        this.scriptGit(event)
        break
      case 'delete':
        this.scriptDelete(event)
        break
      case 'cast':
        this.scriptCast(event)
        break
      case 'done':
        this.pause(PUSH_OUTPUT_PAUSE)
        this.push({ k: 'termDone', durationMs: event.durationMs, aborted: event.aborted })
        break
    }
    for (let i = before; i < this.steps.length; i++) this.remaining += this.steps[i].dur
  }

  // Plays the script for `dtMs` of wall time, sped up so that what is queued
  // never takes longer than the lag allowed. Returns whether anything changed.
  advance(dtMs: number): boolean {
    if (this.isIdle) return false
    const speedup = Math.max(1, this.remaining / this.maxLagMs)
    let budget = dtMs * speedup
    let changed = false
    let executed = 0
    while (this.next < this.steps.length && executed < 50000) {
      if (this.wait > budget) {
        this.wait -= budget
        break
      }
      budget -= this.wait
      const step = this.steps[this.next++]
      this.execute(step)
      this.wait = step.dur
      this.remaining = Math.max(0, this.remaining - step.dur)
      changed = true
      executed++
      if (this.segments.length > 0 && this.segments[0].end <= this.base + this.next) this.settle()
    }
    if (this.isIdle) {
      this.base += this.steps.length
      this.steps = []
      this.next = 0
      this.wait = 0
      this.remaining = 0
    } else if (this.next > 4096) {
      this.base += this.next
      this.steps = this.steps.slice(this.next)
      this.next = 0
    }
    return changed
  }

  // Applies everything queued at once: for while nobody is watching.
  flush(): boolean {
    if (this.isIdle) return false
    while (!this.isIdle) this.advance(Number.MAX_SAFE_INTEGER)
    return true
  }

  private push(step: StepBody, dur = this.speedMs) {
    this.steps.push({ ...step, dur })
  }

  private pause(multiplier: number) {
    this.push({ k: 'pause' }, this.speedMs * multiplier)
  }

  private typing(factor = 1) {
    return this.speedMs * factor * (0.7 + Math.random() * 0.6)
  }

  private scriptTurn(turn: TurnInfo) {
    this.filesThisTurn = 0
    this.push({ k: 'termLine', line: { kind: 'rule', text: `${turn.id} · ${turn.date.slice(-8)}` } })
    this.pause(CHECKOUT_OUTPUT_PAUSE)
    this.push({ k: 'resetTurn', turn })
  }

  private scriptEdit(event: Extract<PlayerEvent, { type: 'edit' }>) {
    const oldLines = splitLines(event.before)
    const newLines = splitLines(event.after)
    const hunks = diffLines(oldLines, newLines)
    if (hunks.length === 0) return
    const { added, deleted } = countChanges(hunks)
    const skipped = untypeable(event.path, hunks)
    if (skipped) {
      this.pause(CHECKOUT_PAUSE)
      this.push({ k: 'count', entry: { path: event.path, status: event.created ? '+' : '~', added, deleted, file: event.file } })
      this.push({
        k: 'termLine',
        line: { kind: 'edit', text: `${cellText(event.path)} · ${words.notReplayed(skipped)}`, right: `+${added} −${deleted}`, ok: true },
      })
      this.pause(GIT_ADD_CMD_PAUSE)
      return
    }
    const change: FileChange = {
      path: event.path,
      oldLines,
      entry: { path: event.path, status: event.created ? '+' : '~', added, deleted, file: event.file },
    }

    // The file already open, as the last change left it: keep typing in place.
    const isOpen = this.scriptedPath === event.path
    // Back from a browser or a picture, the file is opened again even if it was the last.
    const wasCode = this.planScreen === 'code'
    this.planScreen = 'code'
    if (isOpen && wasCode && this.scriptedText === oldLines.join('\n')) {
      this.pause(CHECKOUT_PAUSE)
    } else if (isOpen) {
      this.pause(OPEN_CMD_PAUSE)
      this.push({ k: 'switchFile', change })
      this.pause(FILE_SWITCH_PAUSE)
    } else if (event.file && event.place) {
      this.pause(this.filesThisTurn++ === 0 ? OPEN_FILE_FIRST_PAUSE : OPEN_FILE_PAUSE)
      this.scriptNavigate(event.file, event.place)
      this.push({ k: 'switchFile', change })
      this.pause(FILE_SWITCH_PAUSE)
    } else {
      this.pause(this.filesThisTurn++ === 0 ? OPEN_FILE_FIRST_PAUSE : OPEN_FILE_PAUSE)
      this.push({ k: 'dialogOpen' })
      this.pause(5.0)
      for (const ch of cellText(event.path)) this.push({ k: 'dialogChar', ch }, this.typing(2))
      this.pause(OPEN_CMD_PAUSE)
      this.push({ k: 'switchFile', change })
      this.pause(FILE_SWITCH_PAUSE)
    }
    this.push({ k: 'count', entry: change.entry })
    this.scriptedPath = event.path
    this.scriptedText = newLines.join('\n')
    this.scriptHunks(oldLines, hunks)
    this.pause(GIT_ADD_PAUSE)
    this.push({ k: 'termLine', line: { kind: 'edit', text: cellText(event.path), right: `+${added} −${deleted}`, ok: true } })
    this.pause(GIT_ADD_CMD_PAUSE)
  }

  // Walks the explorer to `file` as a person would: down from where the
  // selection is, opening each closed folder on the way, then onto the file.
  private scriptNavigate(file: string, place: GitloguePlace) {
    const plan = this.plan
    if (this.planSidebar !== 'explorer') {
      this.push({ k: 'sidebar', sidebar: 'explorer' }, 0)
      this.planSidebar = 'explorer'
      this.pause(OPEN_CMD_PAUSE)
    }
    if (!plan.roots.includes(place.root)) {
      this.push({ k: 'root', root: place.root })
      plan.addRoot(place.root)
    }
    const chain = chainTo(place.root, file)
    chain.forEach((dir, i) => {
      const entries = place.listings[dir]
      if (!entries) return
      const ensure = { name: nameOf(chain[i + 1] ?? file), dir: i + 1 < chain.length }
      this.push({ k: 'list', dir, entries, ensure }, 0)
      plan.list(dir, entries, ensure)
    })
    this.planKeep.add(file)
    for (const dir of chain) {
      if (plan.expanded.has(dir)) continue
      this.scriptSelect(dir)
      this.pause(EXPAND_PAUSE)
      this.push({ k: 'expand', dir })
      plan.expanded.add(dir)
      this.pause(EXPAND_PAUSE * 1.5)
    }
    this.scriptSelect(file)
    this.pause(OPEN_CMD_PAUSE)
  }

  // The selection stepping row by row to `target`, easing in and out.
  private scriptSelect(target: string) {
    const plan = this.plan
    const rows = plan.rows(this.planKeep)
    const to = rows.findIndex(row => row.path === target)
    const from = Math.max(0, rows.findIndex(row => row.path === plan.selected))
    if (to >= 0 && to !== from) {
      const distance = Math.abs(to - from)
      const count = Math.min(distance, MAX_SCROLL_STEPS)
      let last = from
      for (let i = 1; i <= count; i++) {
        const t = i / count
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
        const index = Math.round(from + (to - from) * eased)
        if (index === last) continue
        last = index
        this.push({ k: 'select', path: rows[index].path }, 0)
        this.pause(SELECT_STEP_PAUSE)
      }
    }
    if (plan.selected !== target) this.push({ k: 'select', path: target }, 0)
    plan.selected = target
  }

  private toScreen(screen: Screen) {
    if (this.planScreen === screen) return
    this.push({ k: 'screen', screen }, 0)
    this.planScreen = screen
    this.pause(FILE_SWITCH_PAUSE)
  }

  private browse(set: Partial<GitlogueBrowser>, dur = this.speedMs) {
    this.push({ k: 'browse', set }, dur)
    this.planBrowser = { ...this.planBrowser, ...set }
  }

  // A page coming in: the bar across the top fills, unevenly, as pages do.
  private scriptLoad() {
    let loaded = 0
    for (let i = 1; i <= PAGE_LOAD_STEPS; i++) {
      loaded = Math.min(1, loaded + (Math.random() * 2) / PAGE_LOAD_STEPS)
      this.browse({ loading: i === PAGE_LOAD_STEPS ? 1 : loaded }, this.speedMs * (1 + Math.random() * 2))
    }
  }

  // A search, the way a person runs one: the search page, the query typed into
  // its box, Enter, the results page loading, then the results read down.
  private scriptSearch(event: Extract<PlayerEvent, { type: 'search' }>) {
    this.toScreen('browser')
    this.browse({ url: 'google.com', page: 'home', query: '', results: [], shown: 0, selected: -1, body: [], scroll: 0, loading: 1 })
    this.pause(CHECKOUT_OUTPUT_PAUSE)
    for (const ch of cellText(event.query).slice(0, 200)) this.push({ k: 'boxChar', ch }, this.typing())
    this.pause(OPEN_CMD_PAUSE)
    const results = event.results.slice(0, 10).map(link => ({ title: cellText(link.title), url: cellText(link.url) }))
    const seconds = (event.durationMs / 1000).toFixed(2)
    this.browse({
      url: `google.com/search?q=${encodeURIComponent(event.query).replace(/%20/g, '+')}`,
      page: 'results',
      results,
      shown: 0,
      stats: words.webStats(results.length, seconds),
      loading: 0,
    })
    this.scriptLoad()
    for (let i = 1; i <= results.length; i++) this.browse({ shown: i }, this.speedMs * 3)
    this.pause(HUNK_PAUSE)
  }

  // A page opened: clicked from the results when it is one of them, else its
  // address typed; then loaded and read down a screenful at a time.
  private scriptFetch(event: Extract<PlayerEvent, { type: 'fetch' }>) {
    this.toScreen('browser')
    const plan = this.planBrowser
    const target = plan.page === 'results' ? plan.results.findIndex(link => sameAddress(link.url, event.url)) : -1
    if (target >= 0) {
      const from = Math.max(0, plan.selected)
      const step = target >= from ? 1 : -1
      for (let i = from; i !== target + step; i += step) this.browse({ selected: i }, this.speedMs * 4)
      this.pause(OPEN_CMD_PAUSE)
    } else {
      this.browse({ url: '' }, this.speedMs * 4)
      for (const ch of cellText(event.url.replace(/^https?:\/\//, '')).slice(0, 160)) this.push({ k: 'addressChar', ch }, this.typing(0.6))
      this.pause(OPEN_CMD_PAUSE)
    }
    const body = event.text.split('\n').map(cellText)
    this.browse({ url: cellText(event.url.replace(/^https?:\/\//, '')), page: 'page', body, scroll: 0, loading: 0, selected: -1 })
    this.scriptLoad()
    this.pause(CHECKOUT_OUTPUT_PAUSE)
    const reading = Math.min(body.length, 60)
    for (let line = 1; line <= reading; line++) this.browse({ scroll: line }, this.speedMs * (line % 8 === 0 ? 12 : 3))
    this.pause(HUNK_PAUSE)
  }

  // A picture looked at: found in the explorer, opened, and held a moment.
  private scriptImage(event: Extract<PlayerEvent, { type: 'image' }>) {
    if (event.place) this.scriptNavigate(event.file, event.place)
    this.push({ k: 'image', image: { path: cellText(event.path), png: event.png, width: event.width, height: event.height } }, 0)
    this.planScreen = 'image'
    this.pause(HUNK_PAUSE * 1.5)
  }

  // A download: a bar under its command fills at an uneven pace over about
  // the time it took, then the file lands in its folder.
  private scriptDownload(event: Extract<PlayerEvent, { type: 'download' }>) {
    const name = cellText(event.path.slice(event.path.lastIndexOf('/') + 1))
    const total = formatBytes(event.bytes)
    this.push({ k: 'termLine', line: { kind: 'progress', text: name, fraction: 0, right: `0 B / ${total}` } })
    const span = Math.min(6000, Math.max(900, event.durationMs))
    let fraction = 0
    for (let i = 1; i <= DOWNLOAD_STEPS; i++) {
      fraction = i === DOWNLOAD_STEPS ? 1 : Math.min(0.97, fraction + (Math.random() * 2) / DOWNLOAD_STEPS)
      const right = `${formatBytes(event.bytes * fraction)} / ${total}`
      this.push({ k: 'progress', fraction, right }, (span / DOWNLOAD_STEPS) * (0.4 + Math.random() * 1.2))
    }
    this.push({ k: 'progress', fraction: 1, right: `${total} · ${formatDuration(event.durationMs, true)}` })
    if (event.place) {
      const folder = event.file.slice(0, event.file.lastIndexOf('/'))
      const entries = event.place.listings[folder]
      if (entries) {
        if (!this.plan.roots.includes(event.place.root)) {
          this.push({ k: 'root', root: event.place.root })
          this.plan.addRoot(event.place.root)
        }
        const ensure = { name: nameOf(event.file), dir: false }
        this.push({ k: 'list', dir: folder, entries, ensure }, 0)
        this.plan.list(folder, entries, ensure)
      }
      this.planKeep.add(event.file)
    }
    this.push({ k: 'count', entry: { path: event.path, status: '+', added: 0, deleted: 0, file: event.file, note: total } })
    this.pause(GIT_ADD_CMD_PAUSE)
  }

  // Code read with a highlighter: the file opened if it is not already, the
  // cursor brought to what was read, and the pen drawn along each line of it.
  private scriptRead(event: Extract<PlayerEvent, { type: 'read' }>) {
    const lines = splitLines(event.text)
    if (lines.length === 0 || isLog(event.path)) return
    const isOpen = this.planScreen === 'code' && this.scriptedPath === event.path && this.scriptedText === lines.join('\n')
    this.planScreen = 'code'
    if (!isOpen) {
      this.pause(this.filesThisTurn === 0 ? OPEN_FILE_FIRST_PAUSE : OPEN_FILE_PAUSE)
      if (event.place) this.scriptNavigate(event.file, event.place)
      const entry: FileEntry = { path: event.path, status: '~', added: 0, deleted: 0, file: event.file }
      this.push({ k: 'switchFile', change: { path: event.path, oldLines: lines, entry } })
      this.pause(FILE_SWITCH_PAUSE)
      this.scriptedPath = event.path
      this.scriptedText = lines.join('\n')
    }
    const from = Math.min(lines.length - 1, Math.max(0, event.startLine - 1))
    const to = Math.min(lines.length, from + Math.max(1, event.numLines))
    this.scriptCursorMove(0, from, lines)
    this.pause(OPEN_CMD_PAUSE)
    const swept = Math.min(to - from, MAX_READ_SWEEP)
    for (let line = from; line < from + swept; line++) {
      const length = lines[line].length
      for (const share of [0.34, 0.67, 1])
        this.push({ k: 'mark', from, line, col: Math.round(length * share) }, this.speedMs * (length > 0 ? 1.4 : 0.3))
      if ((line - from) % 6 === 5) this.pause(4)
    }
    if (to - from > swept) this.push({ k: 'mark', from, line: to - 1, col: lines[to - 1].length })
    this.pause(HUNK_PAUSE)
  }

  // A search through code, as the editor's search view runs one: the query
  // typed into its box, then the matching files listed one by one, each with
  // its lines.
  private scriptCodeSearch(event: Extract<PlayerEvent, { type: 'codesearch' }>) {
    this.push({ k: 'sidebar', sidebar: 'search' }, 0)
    this.planSidebar = 'search'
    this.push({ k: 'search', set: { query: '', hits: [], shown: 0, total: event.total } })
    this.pause(OPEN_CMD_PAUSE)
    for (const ch of cellText(event.query).slice(0, 80)) this.push({ k: 'searchChar', ch }, this.typing())
    this.pause(OPEN_CMD_PAUSE)
    const hits = event.hits.slice(0, 30).map(hit => ({
      path: cellText(hit.path),
      matches: hit.matches.slice(0, 6).map(match => ({ line: match.line, text: cellText(match.text) })),
    }))
    this.push({ k: 'search', set: { hits } }, 0)
    for (let i = 1; i <= hits.length; i++) this.push({ k: 'search', set: { shown: i } }, this.speedMs * 3)
    this.pause(HUNK_PAUSE)
  }

  // Files found by name, as quick open finds them: the pattern typed into the
  // palette, the matches listed, and the palette put away.
  private scriptFindFiles(event: Extract<PlayerEvent, { type: 'findfiles' }>) {
    this.push({ k: 'palette', set: { text: '', items: [], shown: 0 } }, this.speedMs * 4)
    for (const ch of cellText(event.pattern).slice(0, 60)) this.push({ k: 'paletteChar', ch }, this.typing())
    this.pause(OPEN_CMD_PAUSE)
    const items = event.files.slice(0, 10).map(cellText)
    this.push({ k: 'palette', set: { items } }, 0)
    for (let i = 1; i <= items.length; i++) this.push({ k: 'palette', set: { shown: i } }, this.speedMs * 2)
    this.pause(HUNK_PAUSE)
    this.push({ k: 'palette', set: null })
  }

  // A commit lands in the terminal with its id and branch and the files it
  // took settle in the explorer; a push goes up with a bar, as a download comes down.
  private scriptGit(event: Extract<PlayerEvent, { type: 'git' }>) {
    if (event.commit) {
      this.push({
        k: 'termLine',
        line: { kind: 'commit', text: cellText(event.commit.message ?? ''), sha: event.commit.sha.slice(0, 7), branch: event.commit.branch },
      })
      if (event.root) this.push({ k: 'commitMark', root: event.root })
      this.pause(GIT_ADD_CMD_PAUSE)
    }
    if (event.push) {
      this.push({ k: 'termLine', line: { kind: 'progress', up: true, text: `origin/${event.push.branch}`, fraction: 0, right: 'pushing' } })
      const span = Math.min(4000, Math.max(800, event.durationMs))
      let fraction = 0
      for (let i = 1; i <= DOWNLOAD_STEPS; i++) {
        fraction = i === DOWNLOAD_STEPS ? 1 : Math.min(0.97, fraction + (Math.random() * 2) / DOWNLOAD_STEPS)
        this.push({ k: 'progress', fraction, right: `${Math.round(fraction * 100)}%` }, (span / DOWNLOAD_STEPS) * (0.4 + Math.random() * 1.2))
      }
      this.push({ k: 'progress', fraction: 1, right: words.pushed(formatDuration(event.durationMs, true)) })
      this.pause(GIT_ADD_CMD_PAUSE)
    }
  }

  // A file thrown away: the explorer walks to it, and it flies into the trash.
  private scriptDelete(event: Extract<PlayerEvent, { type: 'delete' }>) {
    this.pause(OPEN_FILE_PAUSE)
    if (event.place) {
      const folder = parentOf(event.file)
      const entries = event.place.listings[folder]
      if (entries)
        event = {
          ...event,
          place: {
            ...event.place,
            listings: { ...event.place.listings, [folder]: [...entries, { name: nameOf(event.file), dir: event.isDir }] },
          },
        }
      this.scriptNavigate(event.file, event.place!)
    }
    this.pause(OPEN_CMD_PAUSE)
    this.push({ k: 'flyStart', file: event.file }, 0)
    for (let i = 1; i <= FLY_STEPS; i++) this.push({ k: 'fly', t: i / FLY_STEPS }, this.speedMs * 1.5)
    this.push({ k: 'trash', file: event.file })
    this.plan.unlist(parentOf(event.file), nameOf(event.file))
    this.planKeep.delete(event.file)
    if (this.scriptedPath === event.path) this.scriptedPath = undefined
    this.push({ k: 'termLine', line: { kind: 'trash', text: cellText(event.path) + (event.isDir ? '/' : '') } })
    this.pause(GIT_ADD_CMD_PAUSE)
  }

  // A recording of Claude at work on one of its screens, played in the
  // editor's area frame by frame at its own pace, then let go.
  private scriptCast(event: Extract<PlayerEvent, { type: 'cast' }>) {
    if (event.frames.length === 0) {
      this.push({ k: 'castEnd', remove: event.remove }, 0)
      return
    }
    const speed = Math.round(event.speed * 10) / 10
    this.push({
      k: 'termLine',
      line: { kind: 'cast', text: `${words.screen(event.screen)} · ${event.seconds.toFixed(1)}s`, right: `×${speed}` },
    })
    this.push({ k: 'castStart', cast: { screen: event.screen, width: event.width, height: event.height, speed, seconds: event.seconds } }, 0)
    this.planScreen = 'cast'
    for (const file of event.frames) this.push({ k: 'castFrame', file }, 1000 / event.fps)
    this.pause(CHECKOUT_OUTPUT_PAUSE)
    this.push({ k: 'castEnd', remove: event.remove }, 0)
    this.planScreen = 'code'
  }

  private scriptHunks(oldLines: string[], hunks: Hunk[]) {
    // The buffer as the script leaves it, for where the cursor lands.
    const buffer = oldLines.slice()
    let cursor = 0
    let offset = 0
    for (const hunk of hunks) {
      const target = Math.max(0, hunk.oldStart - 1 + offset)
      cursor = this.scriptCursorMove(cursor, target, buffer)
      let line = target
      let i = 0
      while (i < hunk.lines.length) {
        const change = hunk.lines[i]
        if (change.kind === 'ctx') {
          if (line !== cursor) {
            this.push({ k: 'move', line, col: indentOf(change.text) })
            this.pause(CURSOR_MOVE_PAUSE)
          }
          cursor = line
          line++
          i++
          continue
        }
        // A run of removed lines and the added lines that replace them.
        const dels: string[] = []
        const adds: string[] = []
        while (i < hunk.lines.length && hunk.lines[i].kind === 'del') dels.push(hunk.lines[i++].text)
        while (i < hunk.lines.length && hunk.lines[i].kind === 'add') adds.push(hunk.lines[i++].text)
        // Line for line, a changed line is edited where it stands when most of
        // it survives; otherwise it goes and its replacement is typed.
        const pairs = Math.min(dels.length, adds.length)
        for (let k = 0; k < pairs; k++) {
          if (isSimilar(dels[k], adds[k])) this.scriptLineEdit(line, dels[k], adds[k])
          else {
            this.scriptDeleteLine(line)
            this.scriptInsertLine(line, adds[k])
          }
          buffer[line] = adds[k]
          cursor = line
          line++
        }
        for (let k = pairs; k < dels.length; k++) {
          this.scriptDeleteLine(line)
          buffer.splice(line, 1)
          cursor = line
          offset--
        }
        for (let k = pairs; k < adds.length; k++) {
          this.scriptInsertLine(line, adds[k])
          buffer.splice(line, 0, adds[k])
          cursor = line
          line++
          offset++
        }
      }
      this.pause(HUNK_PAUSE)
    }
  }

  private scriptDeleteLine(line: number) {
    this.push({ k: 'deleteLine', line })
    this.pause(DELETE_LINE_PAUSE)
  }

  private scriptInsertLine(line: number, text: string) {
    const indent = indentOf(text)
    this.push({ k: 'insertLine', line, text: text.slice(0, indent) })
    for (let col = indent; col < text.length; col++) this.push({ k: 'char', line, col, ch: text[col] }, this.typing())
    this.pause(INSERT_LINE_PAUSE)
  }

  // A line changed in place, as a person edits one: the cursor goes to the end
  // of what differs, backspaces over it, and types what replaces it.
  private scriptLineEdit(line: number, before: string, after: string) {
    let head = 0
    while (head < before.length && head < after.length && before[head] === after[head]) head++
    let tail = 0
    while (
      tail < before.length - head &&
      tail < after.length - head &&
      before[before.length - 1 - tail] === after[after.length - 1 - tail]
    )
      tail++
    const removed = before.length - head - tail
    this.push({ k: 'move', line, col: head + removed })
    this.pause(OPEN_CMD_PAUSE)
    for (let n = 0; n < removed; n++) this.push({ k: 'backspace', line, col: head + removed - n }, this.typing(0.6))
    if (removed > 0) this.pause(CURSOR_MOVE_PAUSE * 4)
    const typed = after.slice(head, after.length - tail)
    for (let n = 0; n < typed.length; n++) this.push({ k: 'char', line, col: head + n, ch: typed[n] }, this.typing())
    this.pause(INSERT_LINE_PAUSE)
  }

  private scriptCursorMove(from: number, to: number, buffer: string[]): number {
    if (from === to) return to
    const distance = Math.abs(to - from)
    const multiplier =
      distance <= 50
        ? CURSOR_MOVE_SHORT_MULTIPLIER
        : distance <= 200
          ? CURSOR_MOVE_MEDIUM_MULTIPLIER
          : CURSOR_MOVE_LONG_MULTIPLIER
    const count =
      distance <= MIN_LOG_STEPS
        ? distance
        : Math.min(MAX_SCROLL_STEPS, Math.max(MIN_LOG_STEPS, Math.floor(Math.log(distance) * LOG_SCALE_FACTOR)))
    const pause = Math.max(0.01, CURSOR_MOVE_PAUSE * multiplier)
    let last = from
    for (let i = 0; i <= count; i++) {
      const t = i / count
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
      const progress = Math.round(eased * distance)
      const line = from < to ? from + progress : from - progress
      if (line === last) continue
      last = line
      this.push({ k: 'move', line, col: indentOf(buffer[line]) })
      this.pause(pause)
    }
    return to
  }

  private execute(step: Step) {
    switch (step.k) {
      case 'char': {
        this.active = 'editor'
        this.marks = undefined
        const text = this.lines[step.line] ?? ''
        this.lines[step.line] = text.slice(0, step.col) + step.ch + text.slice(step.col)
        this.cursorLine = step.line
        this.cursorCol = step.col + 1
        this.highlighter.invalidate(step.line)
        break
      }
      case 'mark':
        this.active = 'editor'
        this.marks = { from: step.from, line: step.line, col: step.col }
        this.cursorLine = Math.min(step.line, this.lines.length - 1)
        this.cursorCol = step.col
        break
      case 'sidebar':
        this.sidebar = step.sidebar
        break
      case 'search':
        this.active = 'explorer'
        this.search = { query: '', hits: [], shown: 0, total: 0, ...this.search, ...step.set }
        break
      case 'searchChar':
        this.active = 'explorer'
        this.search = { query: '', hits: [], shown: 0, total: 0, ...this.search }
        this.search.query += step.ch
        break
      case 'palette':
        this.active = 'explorer'
        this.palette = step.set === null ? undefined : { text: '', items: [], shown: 0, ...this.palette, ...step.set }
        break
      case 'paletteChar':
        if (this.palette) this.palette = { ...this.palette, text: this.palette.text + step.ch }
        break
      case 'termRunning': {
        const last = this.terminal[this.terminal.length - 1]
        if (last?.kind === 'command' && last.right === undefined) last.running = true
        break
      }
      case 'commitMark':
        for (const entry of this.files.values()) if (entry.file?.startsWith(step.root + '/')) entry.committed = true
        break
      case 'flyStart': {
        const keep = new Set([...this.files.values()].flatMap(entry => (entry.file ? [entry.file] : [])))
        const rows = this.explorer.rows(keep)
        const row = rows.findIndex(r => r.path === step.file)
        this.flight = { name: nameOf(step.file), row: Math.max(0, row), depth: rows[row]?.depth ?? 1, t: 0 }
        break
      }
      case 'fly':
        if (this.flight) this.flight = { ...this.flight, t: step.t }
        break
      case 'trash': {
        this.explorer.unlist(parentOf(step.file), nameOf(step.file))
        for (const [path, entry] of [...this.files])
          if (entry.file === step.file || entry.file?.startsWith(step.file + '/')) this.files.delete(path)
        if (this.hasFile && this.currentPath && step.file.endsWith('/' + this.currentPath.replace(/^\//, ''))) {
          this.hasFile = false
          this.lines = ['']
        }
        this.flight = undefined
        this.trashed++
        break
      }
      case 'castStart':
        this.cast = step.cast
        this.castFrame = undefined
        this.setScreen('cast')
        break
      case 'castFrame':
        // The first frame mounts the picture; the rest are swapped into it.
        if (!this.castFrame) this.sceneVersion++
        this.castFrame = step.file
        break
      case 'castEnd':
        this.cast = undefined
        this.castFrame = undefined
        this.removals.push(...step.remove)
        if (this.screen === 'cast') this.setScreen('code')
        break
      case 'backspace': {
        this.active = 'editor'
        const text = this.lines[step.line] ?? ''
        this.lines[step.line] = text.slice(0, step.col - 1) + text.slice(step.col)
        this.cursorLine = step.line
        this.cursorCol = step.col - 1
        this.highlighter.invalidate(step.line)
        break
      }
      case 'insertLine':
        this.active = 'editor'
        if (this.isBlank) this.lines[0] = step.text
        else this.lines.splice(Math.min(step.line, this.lines.length), 0, step.text)
        this.isBlank = false
        this.cursorLine = step.line
        this.cursorCol = step.text.length
        this.highlighter.invalidate(step.line)
        break
      case 'deleteLine':
        this.active = 'editor'
        this.marks = undefined
        this.lines.splice(step.line, 1)
        if (this.lines.length === 0) this.lines.push('')
        this.cursorLine = Math.min(step.line, this.lines.length - 1)
        this.cursorCol = indentOf(this.lines[this.cursorLine])
        this.highlighter.invalidate(step.line)
        break
      case 'move':
        this.active = 'editor'
        this.cursorLine = Math.min(step.line, this.lines.length - 1)
        this.cursorCol = step.col
        break
      case 'pause':
        break
      case 'switchFile': {
        this.marks = undefined
        this.setScreen('code')
        this.active = 'editor'
        this.dialog = undefined
        this.hasFile = true
        this.isBlank = step.change.oldLines.length === 0
        this.lines = this.isBlank ? [''] : step.change.oldLines.slice()
        this.cursorLine = 0
        this.cursorCol = 0
        this.highlighter.setPath(step.change.path)
        this.currentPath = step.change.path
        break
      }
      case 'root':
        this.explorer.addRoot(step.root)
        break
      case 'list':
        this.explorer.list(step.dir, step.entries, step.ensure)
        break
      case 'expand':
        this.active = 'explorer'
        this.explorer.expanded.add(step.dir)
        break
      case 'select':
        this.active = 'explorer'
        this.explorer.selected = step.path
        break
      case 'screen':
        this.setScreen(step.screen)
        break
      case 'browse':
        this.active = 'explorer'
        this.browser = { ...this.browser, focus: undefined, ...step.set }
        break
      case 'boxChar':
        this.active = 'explorer'
        this.browser = { ...this.browser, query: this.browser.query + step.ch, focus: 'box' }
        break
      case 'addressChar':
        this.active = 'explorer'
        this.browser = { ...this.browser, url: this.browser.url + step.ch, focus: 'address' }
        break
      case 'image':
        this.image = step.image
        this.setScreen('image')
        this.sceneVersion++
        break
      case 'progress': {
        for (let i = this.terminal.length - 1; i >= 0; i--) {
          const line = this.terminal[i]
          if (line.kind === 'progress' && (line.fraction ?? 0) < 1) {
            line.fraction = step.fraction
            if (step.right) line.right = step.right
            break
          }
        }
        break
      }
      case 'count': {
        const known = this.files.get(step.entry.path)
        const turn = this.turn?.id
        this.files.set(
          step.entry.path,
          known
            ? { ...known, added: known.added + step.entry.added, deleted: known.deleted + step.entry.deleted, turn }
            : { ...step.entry, turn },
        )
        this.currentPath = step.entry.path
        break
      }
      case 'dialogOpen':
        this.dialog = { title: words.openFile, text: '' }
        break
      case 'dialogChar':
        if (this.dialog) this.dialog.text += step.ch
        break
      case 'termLine':
        this.active = 'terminal'
        this.addLine({ ...step.line, text: cellText(step.line.text) })
        break
      case 'termChar': {
        this.active = 'terminal'
        const last = this.terminal[this.terminal.length - 1]
        if (last?.kind === 'command' && last.right === undefined) last.text += step.ch
        else this.addLine({ kind: 'command', text: step.ch })
        break
      }
      case 'termResult': {
        // The command still waiting on its result, newest first.
        for (let i = this.terminal.length - 1; i >= 0; i--) {
          const line = this.terminal[i]
          if (line.kind === 'command' && line.right === undefined) {
            line.right = step.right
            line.ok = step.ok
            line.running = false
            break
          }
        }
        break
      }
      case 'termDone': {
        this.active = 'terminal'
        const word = this.wordFor(step.durationMs) ?? words.done
        this.addLine(
          step.aborted
            ? { kind: 'fail', text: words.interrupted }
            : { kind: 'done', text: `${word} for ${formatDuration(step.durationMs)}` },
        )
        this.addLine({ kind: 'prompt', text: '' })
        break
      }
      // A new turn keeps the session's files and the open one; only what the
      // turn is about changes.
      case 'resetTurn':
        this.turn = step.turn
        this.turnVersion++
        this.active = 'terminal'
        break
    }
    if (this.terminal.length > MAX_TERMINAL_LINES) this.terminal.splice(0, this.terminal.length - MAX_TERMINAL_LINES)
  }
}

// Logs and other output a program writes as it runs, rotated ones included.
const isLog = (path: string) => /\.(log|out|err|ansi|trace|pid|jsonl)(\.\d+)?$/i.test(path)

// Why a change is not typed out, or undefined when it is.
function untypeable(path: string, hunks: Hunk[]): string | undefined {
  if (LOCK_FILES.has(path.slice(path.lastIndexOf('/') + 1))) return words.lockFile
  if (isLog(path)) return words.logFile
  let typed = 0
  for (const hunk of hunks)
    for (const line of hunk.lines) {
      if (line.text.length > MAX_TYPED_LINE) return words.generated
      if (line.kind === 'add') typed += line.text.length
    }
  return typed > MAX_TYPED_CHARS ? words.tooLarge : undefined
}

// Whether a changed line is mostly the line it replaces: what both start and
// end with covers at least half of the longer one.
function isSimilar(a: string, b: string): boolean {
  if (!a.trim() || !b.trim()) return false
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  return (head + tail) * 2 >= Math.max(a.length, b.length)
}

// Whether two addresses name the same page, ignoring scheme and trailing slash.
function sameAddress(a: string, b: string): boolean {
  const bare = (url: string) => url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
  return bare(a) === bare(b)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function formatDuration(ms: number, precise = false): string {
  if (precise && ms < 10000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}
