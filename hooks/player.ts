// The playback engine: Claude's work arrives as events (a turn begins, a file
// changes, a command runs, the turn ends), each becomes a script of small steps
// the way gitlogue scripts a commit, and `advance` plays the script against the
// clock. Pacing constants are gitlogue's, as multiples of the typing speed.

import type { GitlogueEvent, GitlogueFileEntry, GitlogueSaved, GitlogueTurn, GitlogueView } from '../types'
import { countChanges, diffLines, type Hunk } from './diff'
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
const TAB_WIDTH = 4

export type TurnInfo = GitlogueTurn
export type FileEntry = GitlogueFileEntry
export type PlayerEvent = GitlogueEvent

type FileChange = { path: string; oldLines: string[]; entry: FileEntry }

type StepBody =
  | { k: 'char'; line: number; col: number; ch: string }
  | { k: 'insertLine'; line: number; text: string }
  | { k: 'deleteLine'; line: number }
  | { k: 'move'; line: number; col: number }
  | { k: 'pause' }
  | { k: 'switchFile'; change: FileChange }
  | { k: 'count'; entry: FileEntry }
  | { k: 'dialogOpen' }
  | { k: 'dialogChar'; ch: string }
  | { k: 'termPrompt' }
  | { k: 'termChar'; ch: string }
  | { k: 'termOut'; text: string }
  | { k: 'resetTurn'; turn: TurnInfo }

type Step = StepBody & { dur: number }

// Wide characters take two terminal cells, which a Raster cell cannot hold:
// they become two narrow dots, so columns still line up.
function isWide(cp: number): boolean {
  return (
    cp > 0xffff ||
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x23e9 && cp <= 0x23f3) ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f ||
    cp === 0x2693 ||
    cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26fd) ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2757) ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 ||
    cp === 0x2b55
  )
}

const isInvisible = (cp: number) =>
  (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff

// One line as a run of single-cell characters.
export function cellText(line: string): string {
  let out = ''
  for (const ch of line) {
    const cp = ch.codePointAt(0)!
    if (ch === '\t') out += ' '.repeat(TAB_WIDTH - (out.length % TAB_WIDTH))
    else if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) out += ' '
    else if (isInvisible(cp)) continue
    else if (isWide(cp)) out += '··'
    else out += ch
  }
  return out
}

const splitLines = (text: string) => (text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/).map(cellText))
const indentOf = (line: string | undefined) => (line ?? '').length - (line ?? '').trimStart().length

export class Player {
  // What the panes draw.
  lines: string[] = ['']
  cursorLine = 0
  cursorCol = 0
  active: 'editor' | 'terminal' = 'terminal'
  hasFile = false
  terminal: string[] = []
  dialog: { title: string; text: string } | undefined
  turn: TurnInfo | undefined
  files = new Map<string, FileEntry>()
  currentPath: string | undefined
  readonly highlighter = new Highlighter()
  // Bumped whenever the turn shown changes, for the drawing that shows it.
  turnVersion = 0

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
    return { view: this.checkpoint, pending: this.segments.map(segment => segment.event) }
  }

  restore(saved: GitlogueSaved) {
    const view = saved.view
    this.lines = view.lines.length > 0 ? view.lines.slice() : ['']
    this.cursorLine = view.cursorLine
    this.cursorCol = view.cursorCol
    this.active = view.active
    this.hasFile = view.hasFile
    this.isBlank = view.isBlank
    this.terminal = view.terminal.slice()
    this.turn = view.turn ?? undefined
    this.files = new Map(view.files.map(entry => [entry.path, { ...entry }]))
    this.currentPath = view.currentPath ?? undefined
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

  private view(): GitlogueView {
    return {
      lines: this.lines.slice(),
      cursorLine: this.cursorLine,
      cursorCol: this.cursorCol,
      active: this.active,
      hasFile: this.hasFile,
      isBlank: this.isBlank,
      terminal: this.terminal.slice(),
      turn: this.turn ?? null,
      files: [...this.files.values()].map(entry => ({ ...entry })),
      currentPath: this.currentPath ?? null,
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
        this.push({ k: 'termPrompt' })
        for (const ch of cellText(event.command.replace(/\s*\n\s*/g, ' ; ')).slice(0, 240)) this.push({ k: 'termChar', ch }, this.typing())
        this.pause(GIT_ADD_CMD_PAUSE)
        break
      case 'output':
        for (const line of event.lines) this.push({ k: 'termOut', text: line })
        if (event.failed) this.push({ k: 'termOut', text: '✗ exited with an error' })
        this.pause(PUSH_OUTPUT_PAUSE)
        break
      case 'done':
        this.push({
          k: 'termOut',
          text: event.aborted ? '✗ interrupted' : `✓ done in ${formatDuration(event.durationMs)}`,
        })
        this.pause(PUSH_OUTPUT_PAUSE)
        this.push({ k: 'termPrompt' })
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
    this.scriptedPath = undefined
    this.scriptedText = undefined
    this.push({ k: 'termPrompt' })
    for (const ch of 'claude') this.push({ k: 'termChar', ch }, this.typing())
    this.pause(CHECKOUT_PAUSE)
    this.push({ k: 'termOut', text: `› turn ${turn.id} · ${turn.date}` })
    this.pause(CHECKOUT_OUTPUT_PAUSE)
    this.push({ k: 'resetTurn', turn })
  }

  private scriptEdit(event: Extract<PlayerEvent, { type: 'edit' }>) {
    const oldLines = splitLines(event.before)
    const newLines = splitLines(event.after)
    const hunks = diffLines(oldLines, newLines)
    if (hunks.length === 0) return
    const { added, deleted } = countChanges(hunks)
    const change: FileChange = {
      path: event.path,
      oldLines,
      entry: { path: event.path, status: event.created ? '+' : '~', added, deleted },
    }

    // The file already open, as the last change left it: keep typing in place.
    const isOpen = this.scriptedPath === event.path
    if (isOpen && this.scriptedText === oldLines.join('\n')) {
      this.pause(CHECKOUT_PAUSE)
    } else if (isOpen) {
      this.pause(OPEN_CMD_PAUSE)
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
    this.push({ k: 'termOut', text: `✓ ${event.path} +${added} -${deleted}` })
    this.pause(GIT_ADD_CMD_PAUSE)
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
      for (const change of hunk.lines) {
        if (change.kind === 'del') {
          this.push({ k: 'deleteLine', line })
          this.pause(DELETE_LINE_PAUSE)
          buffer.splice(line, 1)
          cursor = line
          offset--
        } else if (change.kind === 'add') {
          const indent = indentOf(change.text)
          this.push({ k: 'insertLine', line, text: change.text.slice(0, indent) })
          for (let col = indent; col < change.text.length; col++)
            this.push({ k: 'char', line, col, ch: change.text[col] }, this.typing())
          buffer.splice(line, 0, change.text)
          cursor = line
          line++
          offset++
          this.pause(INSERT_LINE_PAUSE)
        } else {
          if (line !== cursor) {
            this.push({ k: 'move', line, col: indentOf(change.text) })
            this.pause(CURSOR_MOVE_PAUSE)
          }
          cursor = line
          line++
        }
      }
      this.pause(HUNK_PAUSE)
    }
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
        const text = this.lines[step.line] ?? ''
        this.lines[step.line] = text.slice(0, step.col) + step.ch + text.slice(step.col)
        this.cursorLine = step.line
        this.cursorCol = step.col + 1
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
      case 'count': {
        const known = this.files.get(step.entry.path)
        this.files.set(
          step.entry.path,
          known
            ? { ...known, added: known.added + step.entry.added, deleted: known.deleted + step.entry.deleted }
            : { ...step.entry },
        )
        this.currentPath = step.entry.path
        break
      }
      case 'dialogOpen':
        this.dialog = { title: 'Open File...', text: '' }
        break
      case 'dialogChar':
        if (this.dialog) this.dialog.text += step.ch
        break
      case 'termPrompt':
        this.active = 'terminal'
        this.terminal.push('~ ')
        break
      case 'termChar':
        this.active = 'terminal'
        if (this.terminal.length === 0) this.terminal.push('~ ')
        this.terminal[this.terminal.length - 1] += step.ch
        break
      case 'termOut':
        this.active = 'terminal'
        this.terminal.push(cellText(step.text))
        break
      case 'resetTurn':
        this.turn = step.turn
        this.turnVersion++
        this.files.clear()
        this.currentPath = undefined
        this.hasFile = false
        this.lines = ['']
        this.cursorLine = 0
        this.cursorCol = 0
        this.active = 'terminal'
        break
    }
    if (this.terminal.length > MAX_TERMINAL_LINES) this.terminal.splice(0, this.terminal.length - MAX_TERMINAL_LINES)
  }
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}
