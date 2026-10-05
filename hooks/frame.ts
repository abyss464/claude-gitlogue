// Paints the player's state as gitlogue lays it out: file tree over turn info
// on the left (30%), editor over terminal on the right (70%), an Open File
// dialog over the middle. Cells are packed as Raster cells: [codePoint, fg, bg].

import { Tok } from './highlight'
import type { FileEntry, Player } from './player'
import type { Theme } from './themes'

export const DEFAULT_COLOR = 0x01000000

export type Layout = {
  width: number
  height: number
  leftWidth: number
  rightWidth: number
  // Rows of the upper panes (tree, editor); the separator follows when there is a lower one.
  topRows: number
  bottomRows: number
}

export function layoutFor(width: number, height: number): Layout {
  const leftWidth = width >= 72 ? Math.floor(width * 0.3) : 0
  const hasBottom = height >= 12
  const topRows = hasBottom ? Math.round((height - 1) * 0.8) : height
  return {
    width,
    height,
    leftWidth,
    rightWidth: width - leftWidth,
    topRows,
    bottomRows: hasBottom ? height - topRows - 1 : 0,
  }
}

export class Canvas {
  readonly width: number
  readonly height: number
  readonly cells: Uint32Array

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.cells = new Uint32Array(width * height * 3)
    for (let i = 0; i < this.cells.length; i += 3) {
      this.cells[i] = 0x20
      this.cells[i + 1] = DEFAULT_COLOR
      this.cells[i + 2] = DEFAULT_COLOR
    }
  }

  set(x: number, y: number, ch: string, fg: number, bg: number) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const i = (y * this.width + x) * 3
    this.cells[i] = ch.charCodeAt(0)
    this.cells[i + 1] = fg
    this.cells[i + 2] = bg
  }

  fill(x: number, y: number, w: number, h: number, bg: number) {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) this.set(col, row, ' ', bg, bg)
  }

  background(x: number, y: number, w: number, bg: number) {
    if (y < 0 || y >= this.height) return
    for (let col = Math.max(0, x); col < Math.min(this.width, x + w); col++) this.cells[(y * this.width + col) * 3 + 2] = bg
  }

  // Writes text from (x, y), cut at `maxX`; returns where it stopped.
  text(x: number, y: number, s: string, fg: number, bg: number, maxX = this.width): number {
    for (let i = 0; i < s.length && x < maxX; i++) this.set(x++, y, s[i], fg, bg)
    return x
  }

  // The cells of one rectangle, base64 as a Raster takes them.
  encode(x: number, y: number, w: number, h: number): string {
    const out = new Uint32Array(w * h * 3)
    for (let row = 0; row < h; row++) {
      const from = ((y + row) * this.width + x) * 3
      out.set(this.cells.subarray(from, from + w * 3), row * w * 3)
    }
    return toBase64(new Uint8Array(out.buffer))
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function toBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  let chunk = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    chunk += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
    if (chunk.length >= 8192) {
      parts.push(chunk)
      chunk = ''
    }
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    chunk += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '=='
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    chunk += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '='
  }
  parts.push(chunk)
  return parts.join('')
}

// Fades a color toward the background, as gitlogue dims rows away from the cursor.
function fade(fg: number, bg: number, distance: number): number {
  if (distance <= 0 || fg === DEFAULT_COLOR || bg === DEFAULT_COLOR) return fg
  const opacity = 1 - (Math.min(distance, 20) / 20) * 0.4
  const mix = (shift: number) =>
    Math.round(((fg >> shift) & 255) * opacity + ((bg >> shift) & 255) * (1 - opacity)) << shift
  return mix(16) | mix(8) | mix(0)
}

function tokenColor(theme: Theme, tok: number): number {
  switch (tok) {
    case Tok.Keyword:
      return theme.syntaxKeyword
    case Tok.Type:
      return theme.syntaxType
    case Tok.Function:
      return theme.syntaxFunction
    case Tok.String:
      return theme.syntaxString
    case Tok.Number:
      return theme.syntaxNumber
    case Tok.Comment:
      return theme.syntaxComment
    case Tok.Operator:
      return theme.syntaxOperator
    case Tok.Punctuation:
      return theme.syntaxPunctuation
    case Tok.Constant:
      return theme.syntaxConstant
    case Tok.Parameter:
      return theme.syntaxParameter
    case Tok.Property:
      return theme.syntaxProperty
    case Tok.Label:
      return theme.syntaxLabel
    default:
      return theme.syntaxVariable
  }
}

type Box = { x: number; y: number; w: number; h: number }

// The inside of a pane after gitlogue's padding: one row top and bottom, two columns each side.
function inner(box: Box): Box {
  const padY = box.h >= 3 ? 1 : 0
  const padX = box.w >= 12 ? 2 : 0
  return { x: box.x + padX, y: box.y + padY, w: box.w - 2 * padX, h: box.h - 2 * padY }
}

export function paint(player: Player, theme: Theme, layout: Layout, cursorOn: boolean): Canvas {
  const canvas = new Canvas(layout.width, layout.height)
  const { leftWidth, rightWidth, topRows, bottomRows } = layout
  if (leftWidth > 0) {
    paintTree(canvas, player, theme, { x: 0, y: 0, w: leftWidth, h: topRows })
    if (bottomRows > 0) {
      canvas.text(0, topRows, '─'.repeat(leftWidth), theme.separator, theme.backgroundLeft)
      canvas.fill(0, topRows + 1, leftWidth, bottomRows, theme.backgroundLeft)
    }
  }
  const editorBox = { x: leftWidth, y: 0, w: rightWidth, h: topRows }
  if (player.screen === 'browser') paintBrowser(canvas, player, theme, editorBox, cursorOn)
  else if (player.screen === 'image' && player.image) paintViewer(canvas, player, theme, editorBox)
  else paintEditor(canvas, player, theme, editorBox, cursorOn)
  if (bottomRows > 0) {
    canvas.text(leftWidth, topRows, '─'.repeat(rightWidth), theme.separator, theme.backgroundRight)
    paintTerminal(canvas, player, theme, { x: leftWidth, y: topRows + 1, w: rightWidth, h: bottomRows }, cursorOn)
  }
  if (player.dialog) paintDialog(canvas, player.dialog, theme)
  return canvas
}

function paintEditor(canvas: Canvas, player: Player, theme: Theme, box: Box, cursorOn: boolean) {
  const bg = theme.backgroundRight
  canvas.fill(box.x, box.y, box.w, box.h, bg)
  const area = inner(box)
  if (area.w <= 0 || area.h <= 0) return

  if (!player.hasFile) {
    const message = player.turn ? 'Waiting for Claude to edit...' : 'Waiting for Claude...'
    const x = area.x + Math.max(0, Math.floor((area.w - message.length) / 2))
    canvas.text(x, area.y + Math.floor(area.h / 2), message, theme.statusNoCommit, bg, area.x + area.w)
    return
  }

  const lines = player.lines
  const numberWidth = Math.max(3, String(lines.length).length)
  const gutter = numberWidth + 1 + 2
  const textWidth = Math.max(1, area.w - gutter)
  const rowsOf = (line: string) => Math.max(1, Math.ceil(line.length / textWidth))

  // Keep the cursor's row in the middle, as gitlogue scrolls.
  let cursorRow = 0
  let total = 0
  for (let i = 0; i < lines.length; i++) {
    if (i === player.cursorLine) cursorRow = total + Math.min(rowsOf(lines[i]) - 1, Math.floor(player.cursorCol / textWidth))
    total += rowsOf(lines[i])
  }
  const half = Math.floor(area.h / 2)
  const top =
    cursorRow < half ? 0 : cursorRow + half >= total ? Math.max(0, total - area.h) : cursorRow - half

  let index = 0
  let skipped = 0
  while (index < lines.length && skipped + rowsOf(lines[index]) <= top) skipped += rowsOf(lines[index++])
  let sub = top - skipped

  const showCursor = cursorOn && player.active === 'editor'
  for (let row = 0; row < area.h && index < lines.length; row++) {
    const y = area.y + row
    const line = lines[index]
    const isCursorLine = index === player.cursorLine
    const rowBg = isCursorLine ? theme.editorCursorLineBg : bg
    const distance = Math.abs(index - player.cursorLine)
    if (isCursorLine) canvas.background(box.x, y, box.w, rowBg)

    if (sub === 0) {
      const number = String(index + 1).padStart(numberWidth) + ' '
      const color = isCursorLine ? theme.editorLineNumberCursor : fade(theme.editorLineNumber, rowBg, distance)
      canvas.text(area.x, y, number, color, rowBg)
    }

    const toks = player.highlighter.line(lines, index)
    const from = sub * textWidth
    const to = Math.min(line.length, from + textWidth)
    const x0 = area.x + gutter
    for (let col = from; col < to; col++)
      canvas.set(x0 + col - from, y, line[col], fade(tokenColor(theme, toks[col]), rowBg, distance), rowBg)

    if (isCursorLine && showCursor) {
      const isLastRow = sub === rowsOf(line) - 1
      const col = player.cursorCol
      if ((col >= from && col < from + textWidth) || (isLastRow && col >= from)) {
        const x = x0 + Math.min(col - from, textWidth - 1)
        canvas.set(x, y, line[col] ?? ' ', theme.editorCursorCharFg, theme.editorCursorCharBg)
      }
    }

    if (++sub >= rowsOf(line)) {
      sub = 0
      index++
    }
  }
}

// The workspace as a file explorer: folders open along the paths Claude has
// walked, the selection where it last went, and each changed file marked with
// its counts; files the current turn has not touched recede.
function paintExplorer(canvas: Canvas, player: Player, theme: Theme, area: Box) {
  const bg = theme.backgroundLeft
  const changed = new Map<string, FileEntry>()
  for (const entry of player.files.values()) if (entry.file) changed.set(entry.file, entry)
  const rows = player.explorer.rows(new Set(changed.keys()))
  const selected = rows.findIndex(row => row.path === player.explorer.selected)
  const offset =
    selected >= area.h ? Math.min(selected - Math.floor(area.h / 2), rows.length - area.h) : 0
  const turn = player.turn?.id
  const maxX = area.x + area.w
  const hasChanges = (dir: string) => [...changed.keys()].some(path => path.startsWith(dir + '/'))

  for (let r = 0; r < area.h && offset + r < rows.length; r++) {
    const index = offset + r
    const row = rows[index]
    const y = area.y + r
    const isSelected = index === selected
    const rowBg = isSelected ? theme.fileTreeCurrentFileBg : bg
    if (isSelected) canvas.background(area.x, y, area.w, rowBg)
    const entry = changed.get(row.path)
    const isPast = entry ? turn !== undefined && entry.turn !== turn : row.kind === 'file'
    const distance = Math.max(selected < 0 ? 0 : Math.abs(index - selected), isPast ? 12 : 0)
    const dim = (color: number) => fade(color, rowBg, distance)
    let x = area.x + row.depth * 2
    const put = (text: string, color: number) => (x = canvas.text(x, y, text, dim(color), rowBg, maxX))

    switch (row.kind) {
      case 'root':
      case 'dir': {
        put(row.isOpen ? '▾ ' : '▸ ', theme.separator)
        const color = hasChanges(row.path) ? theme.fileTreeModified : theme.fileTreeDirectory
        put(row.name + (row.kind === 'dir' ? '/' : ''), row.kind === 'root' ? theme.fileTreeCurrentFileFg : color)
        break
      }
      case 'more':
        put('  ' + row.name, theme.separator)
        break
      case 'file':
        if (!entry) {
          put('  ' + row.name, theme.fileTreeDefault)
          break
        }
        put(entry.status + ' ', entry.status === '+' ? theme.fileTreeAdded : theme.fileTreeModified)
        put(row.name, isSelected ? theme.fileTreeCurrentFileFg : theme.fileTreeDefault)
        if (entry.note) {
          put(' ' + entry.note, theme.editorLineNumber)
          break
        }
        put(` +${entry.added}`, theme.fileTreeStatsAdded)
        put(` -${entry.deleted}`, theme.fileTreeStatsDeleted)
        break
    }
  }
}

// Where the picture sits in the image viewer, in cells of the right column:
// as large as the area allows, at the picture's own proportions (a cell is
// about twice as tall as it is wide), centred.
export function imageBox(layout: Layout, image: { width: number; height: number }) {
  const area = inner({ x: 0, y: 0, w: layout.rightWidth, h: layout.topRows })
  const top = area.y + 2
  const room = { columns: Math.min(255, area.w), rows: Math.min(255, area.h - 2) }
  if (room.columns < 2 || room.rows < 2 || image.width < 1 || image.height < 1) return undefined
  let columns = room.columns
  let rows = Math.round((columns * image.height) / image.width / 2)
  if (rows > room.rows) {
    rows = room.rows
    columns = Math.min(room.columns, Math.round((rows * 2 * image.width) / image.height))
  }
  columns = Math.max(1, columns)
  rows = Math.max(1, rows)
  return {
    left: area.x + Math.floor((room.columns - columns) / 2),
    top: top + Math.floor((room.rows - rows) / 2),
    columns,
    rows,
  }
}

// The picture's frame: its name and size above; the picture itself is laid
// over the empty area by the pane's drawing.
function paintViewer(canvas: Canvas, player: Player, theme: Theme, box: Box) {
  const bg = theme.backgroundRight
  canvas.fill(box.x, box.y, box.w, box.h, bg)
  const area = inner(box)
  const image = player.image
  if (!image || area.w <= 0 || area.h <= 0) return
  let x = canvas.text(area.x, area.y, '▣ ', theme.fileTreeModified, bg)
  x = canvas.text(x, area.y, image.path, theme.fileTreeCurrentFileFg, bg, area.x + area.w)
  canvas.text(x, area.y, `  ${image.width}×${image.height}`, theme.editorLineNumber, bg, area.x + area.w)
  canvas.text(area.x, area.y + 1, '─'.repeat(area.w), theme.separator, bg)
}

const SEARCH_MARK: [string, number][] = [
  ['G', 0x4285f4],
  ['o', 0xea4335],
  ['o', 0xfbbc05],
  ['g', 0x4285f4],
  ['l', 0x34a853],
  ['e', 0xea4335],
]

// The editor's area as a browser: the address bar and the line that fills as
// a page loads, over a search page, its results, or the page being read.
function paintBrowser(canvas: Canvas, player: Player, theme: Theme, box: Box, cursorOn: boolean) {
  const bg = theme.backgroundRight
  canvas.fill(box.x, box.y, box.w, box.h, bg)
  const area = inner(box)
  if (area.w < 12 || area.h < 4) return
  const b = player.browser
  const maxX = area.x + area.w
  const typing = cursorOn && player.active === 'explorer'
  const bar = theme.editorCursorLineBg

  // The address bar.
  let x = canvas.text(area.x, area.y, '‹ › ⟳ ', theme.separator, bg)
  canvas.background(x, area.y, maxX - x, bar)
  x = canvas.text(x, area.y, ' ⌕ ', theme.editorLineNumber, bar)
  const room = maxX - x - 2
  const url = b.url.length > room ? '…' + b.url.slice(b.url.length - room + 1) : b.url
  x = canvas.text(x, area.y, url, theme.fileTreeCurrentFileFg, bar, maxX)
  if (typing && b.focus === 'address') canvas.set(Math.min(x, maxX - 1), area.y, ' ', theme.editorCursorCharFg, theme.editorCursorCharBg)

  // The load line under it.
  const filled = Math.round(area.w * b.loading)
  for (let i = 0; i < area.w; i++)
    canvas.set(area.x + i, area.y + 1, b.loading < 1 && i < filled ? '━' : '─', b.loading < 1 && i < filled ? theme.editorCursorCharBg : theme.separator, bg)

  const top = area.y + 2
  const rows = area.h - 2
  const mark = (mx: number, y: number, spaced: boolean) => {
    for (const [ch, color] of SEARCH_MARK) {
      canvas.set(mx, y, ch, color, bg)
      mx += spaced ? 2 : 1
    }
    return mx
  }

  if (b.page === 'home') {
    const width = Math.min(area.w - 4, 64)
    const left = area.x + Math.floor((area.w - width) / 2)
    const y = top + Math.max(0, Math.floor(rows / 2) - 4)
    mark(area.x + Math.floor((area.w - 11) / 2), y, true)
    searchBox(canvas, theme, left, y + 2, width, b.query, typing && b.focus === 'box', bg)
    const buttons = '[ Google Search ]   [ I’m Feeling Lucky ]'
    canvas.text(area.x + Math.max(0, Math.floor((area.w - buttons.length) / 2)), y + 6, buttons, theme.editorLineNumber, bg, maxX)
    return
  }

  if (b.page === 'results') {
    let mx = mark(area.x, top, false)
    mx += 2
    canvas.background(mx, top, Math.min(maxX - mx, Math.max(20, b.query.length + 6)), bar)
    canvas.text(mx + 1, top, '⌕ ' + b.query, theme.fileTreeCurrentFileFg, bar, maxX)
    canvas.text(area.x, top + 1, b.loading < 1 ? '' : b.stats, theme.editorLineNumber, bg, maxX)
    const per = 3
    const first = Math.max(0, Math.min(b.selected - Math.floor((rows - 3) / per / 2), b.shown - Math.floor((rows - 3) / per)))
    for (let i = first, y = top + 3; i < b.shown && y + 1 < top + rows; i++, y += per) {
      const link = b.results[i]
      const isSelected = i === b.selected
      const rowBg = isSelected ? bar : bg
      if (isSelected) {
        canvas.background(area.x, y, area.w, rowBg)
        canvas.background(area.x, y + 1, area.w, rowBg)
      }
      const host = link.url.replace(/^https?:\/\//, '')
      canvas.text(area.x + 2, y, host.length > area.w - 2 ? host.slice(0, area.w - 3) + '…' : host, theme.statusAuthor, rowBg, maxX)
      canvas.text(area.x + 2, y + 1, link.title.length > area.w - 2 ? link.title.slice(0, area.w - 3) + '…' : link.title, theme.syntaxFunction, rowBg, maxX)
      if (isSelected) canvas.set(area.x, y + 1, '▸', theme.editorCursorCharBg, rowBg)
    }
    return
  }

  // A page being read: its address as the title, the text wrapped, the line
  // being read a third of the way down and the rest receding from it.
  canvas.text(area.x, top, b.url.replace(/\/.*$/, ''), theme.statusHash, bg, maxX)
  const wrapped: { text: string; source: number }[] = []
  // Wrapped at spaces, as a page reflows; a word longer than a line is cut.
  b.body.forEach((line, source) => {
    if (line.length === 0) wrapped.push({ text: '', source })
    let rest = line
    while (rest.length > 0) {
      let cut = rest.length <= area.w ? rest.length : rest.lastIndexOf(' ', area.w)
      if (cut <= 0) cut = Math.min(area.w, rest.length)
      wrapped.push({ text: rest.slice(0, cut), source })
      rest = rest.slice(cut).replace(/^ /, '')
    }
  })
  const start = wrapped.findIndex(row => row.source >= b.scroll)
  const view = rows - 2
  const reading = Math.floor(view / 3)
  const from = Math.max(0, (start < 0 ? wrapped.length : start) - reading)
  let inFence = false
  for (let i = 0; i < from; i++) if (/^\s*```/.test(wrapped[i].text)) inFence = !inFence
  for (let r = 0; r < view && from + r < wrapped.length; r++) {
    const row = wrapped[from + r]
    const y = top + 2 + r
    const distance = Math.abs(r - reading) * 2
    const fence = /^\s*```/.test(row.text)
    const color = fence || inFence
      ? theme.syntaxString
      : /^\s*#/.test(row.text)
        ? theme.syntaxKeyword
        : /^\s*([-*+]|\d+\.)\s/.test(row.text)
          ? theme.syntaxVariable
          : theme.terminalCommand
    if (fence) inFence = !inFence
    canvas.text(area.x, y, row.text, fade(color, bg, distance), bg, maxX)
  }
}

function searchBox(canvas: Canvas, theme: Theme, x: number, y: number, width: number, query: string, cursor: boolean, bg: number) {
  const edge = theme.editorLineNumber
  canvas.text(x, y, '╭' + '─'.repeat(width - 2) + '╮', edge, bg)
  canvas.set(x, y + 1, '│', edge, bg)
  canvas.set(x + width - 1, y + 1, '│', edge, bg)
  canvas.text(x, y + 2, '╰' + '─'.repeat(width - 2) + '╯', edge, bg)
  const room = width - 6
  const shown = query.length > room ? '…' + query.slice(query.length - room + 1) : query
  const end = canvas.text(canvas.text(x + 2, y + 1, '⌕ ', theme.editorLineNumber, bg), y + 1, shown, theme.fileTreeCurrentFileFg, bg)
  if (cursor) canvas.set(end, y + 1, ' ', theme.editorCursorCharFg, theme.editorCursorCharBg)
}

type TreeRow = { dir: string } | { entry: FileEntry; name: string; indent: boolean }

function treeRows(files: Map<string, FileEntry>): TreeRow[] {
  const byDir = new Map<string, FileEntry[]>()
  for (const entry of files.values()) {
    const cut = entry.path.lastIndexOf('/')
    const dir = cut < 0 ? '' : entry.path.slice(0, cut)
    byDir.set(dir, [...(byDir.get(dir) ?? []), entry])
  }
  const rows: TreeRow[] = []
  for (const dir of [...byDir.keys()].sort()) {
    if (dir) rows.push({ dir })
    const entries = byDir.get(dir)!.map(entry => ({ entry, name: entry.path.slice(dir ? dir.length + 1 : 0) }))
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const { entry, name } of entries) rows.push({ entry, name, indent: dir !== '' })
  }
  return rows
}

function paintTree(canvas: Canvas, player: Player, theme: Theme, box: Box) {
  const bg = theme.backgroundLeft
  canvas.fill(box.x, box.y, box.w, box.h, bg)
  const area = inner(box)
  if (area.w <= 0 || area.h <= 0) return
  if (player.explorer.roots.length > 0) return paintExplorer(canvas, player, theme, area)
  const rows = treeRows(player.files)
  // Files the current turn has not touched recede.
  const turn = player.turn?.id
  const isOld = (entry: FileEntry) => turn !== undefined && entry.turn !== turn
  const oldDirs = new Set(
    [...new Set([...player.files.values()].map(entry => entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/')))))].filter(
      dir => [...player.files.values()].every(entry => !entry.path.startsWith(dir + '/') || isOld(entry)),
    ),
  )
  const selected = rows.findIndex(row => 'entry' in row && row.entry.path === player.currentPath)
  const offset =
    selected >= area.h ? Math.min(selected - Math.floor(area.h / 2), rows.length - area.h) : 0
  const maxX = area.x + area.w

  for (let r = 0; r < area.h && offset + r < rows.length; r++) {
    const index = offset + r
    const row = rows[index]
    const y = area.y + r
    const isSelected = index === selected
    const rowBg = isSelected ? theme.fileTreeCurrentFileBg : bg
    const isPast = 'dir' in row ? oldDirs.has(row.dir) : isOld(row.entry)
    const distance = Math.max(selected < 0 ? 0 : Math.abs(index - selected), isPast ? 14 : 0)
    const dim = (color: number) => fade(color, rowBg, distance)
    if (isSelected) canvas.background(area.x, y, area.w, rowBg)
    if ('dir' in row) {
      canvas.text(area.x, y, row.dir + '/', dim(theme.fileTreeDirectory), rowBg, maxX)
      continue
    }
    const { entry } = row
    const statusColor = entry.status === '+' ? theme.fileTreeAdded : theme.fileTreeModified
    let x = area.x + (row.indent ? 2 : 0)
    x = canvas.text(x, y, entry.status + ' ', dim(statusColor), rowBg, maxX)
    const nameColor = isSelected ? theme.fileTreeCurrentFileFg : theme.fileTreeDefault
    x = canvas.text(x, y, row.name, dim(nameColor), rowBg, maxX)
    x = canvas.text(x, y, ` +${entry.added}`, dim(theme.fileTreeStatsAdded), rowBg, maxX)
    canvas.text(x, y, ` -${entry.deleted}`, dim(theme.fileTreeStatsDeleted), rowBg, maxX)
  }
}

// Claude's own mark, the one color the terminal keeps whatever the theme.
const CLAUDE = 0xd77757

// The shell as Claude meets it: what each command is for, the command, the
// head of what came back, the files written, and how the turn closed. Rows
// fade as they recede, the way older context does.
function paintTerminal(canvas: Canvas, player: Player, theme: Theme, box: Box, cursorOn: boolean) {
  const bg = theme.backgroundRight
  canvas.fill(box.x, box.y, box.w, box.h, bg)
  const area = inner(box)
  if (area.w <= 0 || area.h <= 0) return
  const lines = player.terminal
  const start = Math.max(0, lines.length - area.h)
  const maxX = area.x + area.w
  const fit = (text: string, room: number, keepTail = false) =>
    text.length <= room ? text : room <= 1 ? '' : keepTail ? '…' + text.slice(text.length - room + 1) : text.slice(0, room - 1) + '…'

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    const y = area.y + i - start
    const isLast = i === lines.length - 1
    const age = Math.min(20, (lines.length - 1 - i) * 3)
    const ink = (color: number) => fade(color, bg, age)
    let x = area.x
    const put = (text: string, color: number) => (x = canvas.text(x, y, text, ink(color), bg, maxX))
    const right = line.right ?? ''
    const room = (lead: number) => Math.max(0, area.w - lead - (right ? right.length + 2 : 0))

    switch (line.kind) {
      case 'rule': {
        const [id = '', time = ''] = line.text.split(' · ')
        put('── ', theme.separator)
        put(id, theme.statusHash)
        put(' · ', theme.separator)
        put(time, theme.statusDate)
        put(' ' + '─'.repeat(Math.max(0, maxX - x - 1)), theme.separator)
        break
      }
      case 'intent':
        put('# ' + fit(line.text, area.w - 2), theme.syntaxComment)
        break
      case 'command': {
        put('❯ ', CLAUDE)
        const isTyping = line.right === undefined
        put(fit(line.text, room(2) - (isTyping ? 1 : 0), isTyping), theme.terminalCommand)
        if (isLast && isTyping && cursorOn && player.active === 'terminal')
          canvas.set(Math.min(x, maxX - 1), y, ' ', theme.terminalCursorFg, theme.terminalCursorBg)
        if (right) {
          const cut = right.indexOf(' ')
          x = maxX - right.length
          put(right.slice(0, cut + 1), theme.terminalOutput)
          put(right.slice(cut + 1), line.ok ? theme.fileTreeAdded : theme.fileTreeDeleted)
        }
        break
      }
      case 'output':
        put(line.first ? '  ⎿  ' : '     ', theme.separator)
        put(fit(line.text, area.w - 5), theme.terminalOutput)
        break
      case 'more':
        put('     ' + fit(line.text, area.w - 5), theme.separator)
        break
      case 'edit': {
        put('✎ ', theme.fileTreeModified)
        put(fit(line.text, room(2)), theme.terminalCommand)
        if (right) {
          const [added = '', deleted = ''] = right.split(' ')
          x = maxX - right.length
          put(added + ' ', theme.fileTreeStatsAdded)
          put(deleted, theme.fileTreeStatsDeleted)
        }
        break
      }
      case 'done':
        put('✻ ', CLAUDE)
        put(fit(line.text, area.w - 2), theme.terminalOutput)
        break
      case 'fail':
        put('✗ ' + fit(line.text, area.w - 2), theme.fileTreeDeleted)
        break
      case 'progress': {
        const done = (line.fraction ?? 0) >= 1
        put(done ? '✓ ' : '↓ ', done ? theme.fileTreeAdded : CLAUDE)
        put(fit(line.text, Math.max(8, Math.floor(area.w / 3))) + ' ', theme.terminalCommand)
        const barWidth = Math.max(4, maxX - x - right.length - 2)
        const full = Math.round(barWidth * (line.fraction ?? 0))
        put('━'.repeat(full), done ? theme.fileTreeAdded : theme.editorCursorCharBg)
        put('─'.repeat(barWidth - full), theme.separator)
        x = maxX - right.length
        put(right, theme.terminalOutput)
        break
      }
      case 'prompt':
        put('❯ ', CLAUDE)
        if (isLast && cursorOn) canvas.set(x, y, ' ', theme.terminalCursorFg, theme.terminalCursorBg)
        break
    }
  }
}

function paintDialog(canvas: Canvas, dialog: { title: string; text: string }, theme: Theme) {
  const width = Math.min(canvas.width, Math.max(60, dialog.text.length + 10))
  if (width < 8 || canvas.height < 3) return
  const x = Math.floor((canvas.width - width) / 2)
  const y = Math.floor((canvas.height - 3) / 2)
  const fg = theme.fileTreeCurrentFileFg
  const bg = theme.editorCursorLineBg
  canvas.fill(x, y, width, 3, bg)
  canvas.text(x, y, '┌' + '─'.repeat(width - 2) + '┐', fg, bg)
  canvas.text(x + 1, y, dialog.title.slice(0, width - 2), fg, bg)
  canvas.set(x, y + 1, '│', fg, bg)
  canvas.set(x + width - 1, y + 1, '│', fg, bg)
  canvas.text(x, y + 2, '└' + '─'.repeat(width - 2) + '┘', fg, bg)
  const room = width - 4
  const shown = dialog.text.length > room ? '…' + dialog.text.slice(dialog.text.length - room + 1) : dialog.text
  canvas.text(x + 2, y + 1, shown, fg, bg)
}
