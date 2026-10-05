// gitlogue for Claude Code: replays every change Claude makes the way gitlogue
// replays a commit, typed into an editor in a pane beside the conversation.
// A turn is the commit: its prompt is the message, the files it touches form
// the tree, the commands it runs scroll through the terminal.

import type { Register } from 'claude-code'

import { candidatePaths, reverseApply, type EngineHunk } from './bashfiles'
import { layoutFor, paint, type Layout } from './frame'
import { Player, type PlayerEvent } from './player'
import { DEFAULT_THEME, THEMES } from './themes'

const PANE = 'gitlogue'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const FAST_TICK_MS = 33
const BLINK_MS = 500
const MAX_SNAPSHOT_BYTES = 1_000_000

type BashEditFile = { filePath: string; hunks: EngineHunk[]; created?: true; deleted?: true }

// Rasters paint colors snapped to four bits a channel; text drawn beside them
// snaps the same way so the two read as one surface.
const hex = (color: number) =>
  '#' +
  [16, 8, 0]
    .map(shift => (Math.round(((color >> shift) & 255) / 17) * 17).toString(16).padStart(2, '0'))
    .join('')

function stamp(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

export const register: Register = (on, options) => {
  const theme = THEMES[String(options.theme)] ?? THEMES[DEFAULT_THEME]
  const speedMs = Math.max(1, Number(options.speed) || 30)
  const maxLagMs = Math.max(1, Number(options.maxLag) || 20) * 1000
  const openAtStart = options.open !== 'command'

  const player = new Player(speedMs, maxLagMs)
  let cwd = ''
  // The pane's size while it is drawn; undefined while nobody sees it.
  let mounted: Layout | undefined
  let shownTurn = -1
  let lastTick = Date.now()
  let sent = { tree: '', main: '' }
  let isBlitting = false
  let timer: { cancel: () => void } | undefined
  let timerMs = 0

  const display = (path: string) =>
    cwd && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path

  const frames = (layout: Layout) => {
    const canvas = paint(player, theme, layout, Math.floor(Date.now() / BLINK_MS) % 2 === 0)
    const treeRows = layout.bottomRows > 0 ? layout.topRows + 1 : layout.height
    return {
      treeRows,
      tree: layout.leftWidth > 0 ? canvas.encode(0, 0, layout.leftWidth, treeRows) : '',
      main: canvas.encode(layout.leftWidth, 0, layout.rightWidth, layout.height),
    }
  }

  // The clock that plays the script, set up where the session's engine is in reach.
  let schedule = () => {}

  const enqueue = (event: PlayerEvent) => {
    player.enqueue(event)
    if (!mounted) player.flush()
    schedule()
  }

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    lastTick = Date.now()

    const tick = () => {
      const now = Date.now()
      const dt = Math.min(1000, now - lastTick)
      lastTick = now
      if (!mounted) {
        player.flush()
        schedule()
        return
      }
      player.advance(dt)
      if (player.turnVersion !== shownTurn) {
        // The turn info is drawn as text; a redraw remounts the rasters too.
        shownTurn = player.turnVersion
        $.ui.invalidate('ui.render')
      } else if (!isBlitting) {
        const layout = mounted
        const frame = frames(layout)
        const blits: Promise<unknown>[] = []
        if (frame.main !== sent.main)
          blits.push($.ui.blit({ requestId: PANE, key: 'main', cells: frame.main, columns: layout.rightWidth, rows: layout.height }))
        if (frame.tree && frame.tree !== sent.tree)
          blits.push($.ui.blit({ requestId: PANE, key: 'tree', cells: frame.tree, columns: layout.leftWidth, rows: frame.treeRows }))
        sent = { tree: frame.tree, main: frame.main }
        if (blits.length > 0) {
          isBlitting = true
          void Promise.allSettled(blits).then(() => (isBlitting = false))
        }
      }
      schedule()
    }

    schedule = () => {
      const wanted = mounted ? (player.isIdle ? BLINK_MS : FAST_TICK_MS) : 0
      if (wanted === timerMs) return
      timer?.cancel()
      timer = undefined
      timerMs = wanted
      if (wanted > 0) timer = $.clock.every(wanted, tick)
    }

    await $.command.register({
      name: 'gitlogue',
      description: "Show or hide the gitlogue pane, which replays Claude's edits as live typing",
    })
    if (openAtStart && e.isInteractive) void $.ui.open({ id: PANE, title: 'gitlogue', rows: 24 })
    // After a reload the pane may still be up, drawn by the module before this one.
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('command.run', { command: 'gitlogue' }, async $ => {
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen) await $.ui.close({ id: PANE })
    else await $.ui.open({ id: PANE, title: 'gitlogue', rows: 24 })
    return {}
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    mounted = undefined
    schedule()
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    const id = e.turnId.replace(/[^0-9a-f]/gi, '').slice(0, 7) || e.turnId.slice(0, 7)
    const prompt = e.text.trim() || '(continued)'
    enqueue({ type: 'turn', turn: { id, date: stamp(Date.now()), prompt: prompt.slice(0, 600) } })
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) enqueue({ type: 'done', durationMs: e.durationMs, aborted: e.isAborted })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Bash') {
      const command = String((e as { command?: unknown }).command ?? '')
      enqueue({ type: 'command', command })

      // The text of a file now: a string, null when it does not exist, or
      // undefined when it is no text file to replay (a folder, binary, huge).
      const look = (path: string): Promise<string | null | undefined> =>
        $.fs.stat(path).then(
          stat =>
            stat.kind === 'file' && stat.size <= MAX_SNAPSHOT_BYTES
              ? $.fs.read(path).then(text => (typeof text === 'string' && !text.includes('\u0000') ? text : undefined))
              : undefined,
          () => null,
        )
      const home = (await $.env.get('HOME')) ?? ''
      const paths = candidatePaths(command, await $.session.cwd(), home)
      const before = new Map<string, string | null>()
      await Promise.all(
        paths.map(async path => {
          const text = await look(path).catch(() => undefined)
          if (text !== undefined) before.set(path, text)
        }),
      )

      const ran = await next(e)

      const edits: PlayerEvent[] = []
      const seen = new Set<string>()
      for (const [path, old] of before) {
        const now = await look(path).catch(() => undefined)
        if (typeof now !== 'string' || now === old) continue
        seen.add(path)
        edits.push({ type: 'edit', path: display(path), before: old ?? '', after: now, created: old === null })
      }
      // What the engine saw the command change, for files the command never names.
      const result = 'result' in ran ? (ran.result as { bashEditDiff?: { files?: BashEditFile[] } } | undefined) : undefined
      for (const file of result?.bashEditDiff?.files ?? []) {
        if (file.deleted || seen.has(file.filePath)) continue
        const now = await look(file.filePath).catch(() => undefined)
        if (typeof now !== 'string') continue
        const old = file.created ? '' : reverseApply(now, file.hunks)
        if (old !== now) edits.push({ type: 'edit', path: display(file.filePath), before: old, after: now, created: file.created === true })
      }
      edits.forEach(enqueue)

      const text = ran.deny ?? ran.text ?? ''
      const lines = text
        .split('\n')
        .map(line => line.trimEnd())
        .filter(line => line.trim() !== '')
        .slice(0, 3)
      enqueue({ type: 'output', lines, failed: ran.deny !== undefined || ran.isError === true })
      return ran
    }

    if (!EDIT_TOOLS.has(String(e.tool))) return next(e)
    const path = String((e as { file_path?: unknown }).file_path ?? '')
    const read = (): Promise<string | undefined> => $.fs.read(path).then(
      text => (typeof text === 'string' ? text : undefined),
      () => undefined,
    )
    const before = path ? await read() : undefined
    const ran = await next(e)
    if (!path || ran.deny !== undefined || ran.isError === true) return ran
    const after = await read()
    if (after !== undefined && after !== before)
      enqueue({ type: 'edit', path: display(path), before: before ?? '', after, created: before === undefined })
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (e.surface !== 'terminal') return <Text dimColor>gitlogue draws in the terminal.</Text>
    const { Raster } = $.ui.resolve(e)

    const width = Math.min(512, e.props.bodyColumns)
    const height = Math.min(256, e.props.scroll.bodyRows)
    if (width < 20 || height < 4) {
      mounted = undefined
      return <Text dimColor>gitlogue needs more room.</Text>
    }
    const layout = layoutFor(width, height)
    mounted = layout
    shownTurn = player.turnVersion
    const frame = frames(layout)
    sent = { tree: frame.tree, main: frame.main }
    schedule()

    const turn = player.turn
    const left = hex(theme.backgroundLeft)
    // Each row keeps its height; what does not fit is cut at the bottom.
    const row = (text: ReturnType<typeof Text>) => <Box flexShrink={0}>{text}</Box>
    const label = (name: string, value: string, color: number) =>
      row(
        <Text backgroundColor={left}>
          <Text>{name}</Text>
          <Text color={hex(color)}>{value}</Text>
        </Text>,
      )

    const info = turn
      ? [
          label('turn: ', turn.id, theme.statusHash),
          label('author: ', 'Claude', theme.statusAuthor),
          label('date: ', turn.date, theme.statusDate),
          ...turn.prompt
            .split('\n')
            .filter(line => line.trim() !== '')
            .map(line =>
              row(
                <Text color={hex(theme.statusMessage)} backgroundColor={left}>
                  {line}
                </Text>,
              ),
            ),
        ]
      : [
          <Text color={hex(theme.statusNoCommit)} backgroundColor={left}>
            No turn yet
          </Text>,
        ]

    return (
      <Box flexDirection="row" width={width} height={height}>
        {layout.leftWidth > 0 && (
          <Box flexDirection="column" width={layout.leftWidth} height={height}>
            <Raster key="tree" columns={layout.leftWidth} rows={frame.treeRows} cells={frame.tree} />
            {layout.bottomRows > 0 && (
              <Box
                flexDirection="column"
                width={layout.leftWidth}
                height={layout.bottomRows}
                backgroundColor={left}
                paddingX={2}
                paddingY={layout.bottomRows >= 4 ? 1 : 0}
                overflow="hidden"
              >
                {info}
              </Box>
            )}
          </Box>
        )}
        <Raster key="main" columns={layout.rightWidth} rows={height} cells={frame.main} />
      </Box>
    )
  })
}
