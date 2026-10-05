// gitlogue for Claude Code: replays every change Claude makes the way gitlogue
// replays a commit, typed into an editor in a pane beside the conversation.
// A turn is the commit: its prompt is the message, the files it touches form
// the tree, the commands it runs scroll through the terminal.

import type { Register } from 'claude-code'

import type { GitlogueLink, GitloguePlace, GitlogueSaved } from '../types'

import { candidatePaths, commitMessageOf, downloadTargets, hitsOf, reverseApply, searchOf, type EngineHunk } from './bashfiles'
import { chainTo, parentOf, type DirEntry } from './explorer'
import { Chat, drawPhone, registerChat } from './chat'
import { imageBox, layoutFor, paint, type Layout } from './frame'
import { Player, type PlayerEvent } from './player'
import { DEFAULT_THEME, THEMES } from './themes'

const PANE = 'gitlogue'
const SAVED = { plugin: 'gitlogue', key: 'saved' } as const
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const FAST_TICK_MS = 33
const BLINK_MS = 500
const MAX_SNAPSHOT_BYTES = 1_000_000
// With the chat in it, the pane asks to take nearly the whole width: the
// transcript beside it has nothing left to show.
const WIDE_DOCK = 400
// The replays kept for /resume: the newest few sessions, each within a share of
// the 4 MiB store.
const KEPT_SESSIONS = 3
const MAX_RECORD_CHARS = 1_000_000
const RECENT_KEY = 'replays'
const recordKey = (session: string) => `replay:${session}`

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

// A short, stable name for a path, for the PNG copies of pictures.
function hashOf(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return (hash >>> 0).toString(16)
}

export const register: Register = (on, options) => {
  const theme = THEMES[String(options.theme)] ?? THEMES[DEFAULT_THEME]
  // gitlogue types at 30 ms a character; the playback option scales all of it,
  // and how far the replay may fall behind scales with it.
  const rate = Math.min(10, Math.max(0.1, parseFloat(String(options.playback)) || 1))
  const speedMs = 30 / rate
  const maxLagMs = (Math.max(1, Number(options.maxLag) || 20) * 1000) / rate
  const openAtStart = options.open !== 'command'
  const chatOption = options.chat !== 'off'

  const player = new Player(speedMs, maxLagMs)
  let cwd = ''
  // The pane's size while it is drawn; undefined while nobody sees it.
  let mounted: Layout | undefined
  let shownTurn = -1
  let shownScene = -1
  // The conversation reads as a phone chat while the pane is drawn.
  const isChatOn = () => chatOption && mounted !== undefined
  let chatShown = false
  let shownCounts = -1
  // How wide the phone was last drawn: the wheel left of it scrolls the chat.
  let phoneShown = 0
  let shownChat = -1
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

  // The clock that plays the script, and the record that outlives a reload of
  // this module, set up where the session's engine is in reach.
  let schedule = () => {}
  let persist = () => {}
  let resume = async (_id: string) => {}

  const enqueue = (event: PlayerEvent) => {
    player.enqueue(event)
    if (!mounted) player.flush()
    schedule()
    persist()
  }

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    chat.load(await $.session.messages().catch(() => []))
    lastTick = Date.now()

    let session = await $.session.id()
    const stored = await $.store.get(RECENT_KEY)
    let recent: string[] = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
    let storedAt = 0

    // The replay as a record small enough to keep: everything still to play,
    // else the panes alone, else the panes without the open file.
    const record = (): GitlogueSaved => {
      const full = player.save()
      if (JSON.stringify(full).length <= MAX_RECORD_CHARS) return full
      const view = player.view()
      const panes = { view, pending: [] }
      if (JSON.stringify(panes).length <= MAX_RECORD_CHARS) return panes
      return { view: { ...view, lines: [''], hasFile: false, currentPath: null }, pending: [] }
    }

    // Kept for /resume, at most every couple of seconds while playing and
    // always once the replay has caught up.
    const keep = () => {
      const now = Date.now()
      if (!player.isIdle && now - storedAt < 2000) return
      storedAt = now
      const id = session
      void $.store.set(recordKey(id), record()).catch(() => {})
      if (recent[0] === id) return
      const dropped = recent.filter(other => other !== id).slice(KEPT_SESSIONS - 1)
      recent = [id, ...recent.filter(other => other !== id)].slice(0, KEPT_SESSIONS)
      for (const old of dropped) void $.store.delete(recordKey(old)).catch(() => {})
      void $.store.set(RECENT_KEY, recent).catch(() => {})
    }

    let savedVersion = -1
    persist = () => {
      if (player.saveVersion === savedVersion) return
      savedVersion = player.saveVersion
      void $.state.set(SAVED, { ...player.save(), session }).catch(() => {})
      keep()
    }

    // The session's last replay, from a reload of this module (an edit, a
    // changed option) or from an earlier run this session resumes.
    const load = async () => {
      const { value: live } = await $.state.get(SAVED)
      if (live && live.session === session) return player.restore(live)
      const kept = (await $.store.get(recordKey(session))) as GitlogueSaved | undefined
      if (kept?.view) {
        player.restore(kept)
        player.flush()
      }
    }
    await load()
    savedVersion = player.saveVersion
    resume = async (id: string) => {
      if (id === session) return
      session = id
      const kept = (await $.store.get(recordKey(id))) as GitlogueSaved | undefined
      if (kept?.view) {
        player.restore(kept)
        player.flush()
      } else player.reset()
      persist()
      schedule()
    }

    const tick = () => {
      const now = Date.now()
      const dt = Math.min(1000, now - lastTick)
      lastTick = now
      if (!mounted) {
        player.flush()
        schedule()
        persist()
        return
      }
      player.advance(dt)
      persist()
      // The chat coming or going, or the turn's counts moving under it, redraw
      // the transcript and the turn info.
      const counts = [...player.files.values()].reduce((n, f) => n + f.added * 7 + f.deleted * 13 + 1, 0)
      if (isChatOn() !== chatShown || (isChatOn() && (counts !== shownCounts || chat.version !== shownChat))) {
        chatShown = isChatOn()
        shownCounts = counts
        shownChat = chat.version
        $.ui.invalidate('ui.render')
      }
      if (player.turnVersion !== shownTurn || player.sceneVersion !== shownScene) {
        // The turn info is drawn as text and a picture as an image; a redraw
        // remounts the rasters too.
        shownTurn = player.turnVersion
        shownScene = player.sceneVersion
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
      const wanted = mounted ? (player.isIdle ? (player.hasRunning ? 100 : BLINK_MS) : FAST_TICK_MS) : 0
      if (wanted === timerMs) return
      timer?.cancel()
      timer = undefined
      timerMs = wanted
      if (wanted > 0) timer = $.clock.every(wanted, tick)
    }

    // A tool that redraws the mod with its latest code, since calling a
    // plugin's own tool reloads it first: for checking a change to the mod.
    await $.tool.register({
        name: 'refresh',
        description:
          'Reload the gitlogue mod with its latest saved code and redraw its pane and chat view, to check a change to the mod before the turn ends. chat_scroll, when given, scrolls the chat that many rows up from its newest line (0 back to the newest).',
        inputSchema: { type: 'object', properties: { chat_scroll: { type: 'number' } } },
      })
    await $.command.register({
      name: 'gitlogue',
      description: "Show or hide the gitlogue pane, which replays Claude's edits as live typing",
    })
    if (openAtStart && e.isInteractive) void $.ui.open({ id: PANE, title: 'gitlogue', rows: 24, ...(chatOption ? { columns: WIDE_DOCK } : {}) })
    // After a reload the pane may still be up, drawn by the module before this one.
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // The words Claude Code closes each turn with (`Cogitated for 1m 57s`), by
  // the turn's length, so the terminal ends the turn in the same words.
  const words = new Map<number, string>()
  player.wordFor = durationMs => {
    let best: string | undefined
    let gap = 2000
    for (const [ms, word] of words) {
      if (Math.abs(ms - durationMs) < gap) {
        gap = Math.abs(ms - durationMs)
        best = word
      }
    }
    return best
  }
  on('ui.render', { component: 'TurnDuration' }, ($, e, next) => {
    words.set(e.props.durationMs, e.props.word)
    if (words.size > 50) words.delete(words.keys().next().value as number)
    if (!isChatOn() || e.surface !== 'terminal') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  const chat = new Chat()
  registerChat(on, { isOn: isChatOn, chat })

  // /resume inside a running session switches to another one's replay.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'resume') await resume(e.session_id)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__gitlogue__refresh' }, ($, e) => {
    const lift = (e as { chat_scroll?: unknown }).chat_scroll
    if (typeof lift === 'number') chat.scrollBy(lift - chat.scroll)
    $.ui.invalidate('ui.render')
    return { result: 'The gitlogue mod is running its latest code; its pane and chat view are redrawn.' }
  })

  on('command.run', { command: 'gitlogue' }, async $ => {
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen) await $.ui.close({ id: PANE })
    else await $.ui.open({ id: PANE, title: 'gitlogue', rows: 24, ...(chatOption ? { columns: WIDE_DOCK } : {}) })
    return {}
  })

  // The wheel over the phone, or the scroll keys while the pane has them,
  // move the chat's messages; the pane itself stays where it is.
  on('ui.scroll', { requestId: PANE }, ($, e, next) => {
    if (!isChatOn() || phoneShown === 0 || (e.pointer && e.pointer.column >= phoneShown)) return next(e)
    chat.scrollBy(-e.by * (e.pointer ? 3 : 1))
    $.ui.invalidate('ui.render')
    return { deny: 'the phone scrolls its own messages' }
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    mounted = undefined
    chatShown = false
    $.ui.invalidate('ui.render')
    schedule()
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    chat.working(true)
    const id = e.turnId.replace(/[^0-9a-f]/gi, '').slice(0, 7) || e.turnId.slice(0, 7)
    const prompt = e.text.trim() || '(continued)'
    enqueue({ type: 'turn', turn: { id, date: stamp(Date.now()), prompt: prompt.slice(0, 600) } })
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) chat.working(false)
    if (e.agentId === undefined) enqueue({ type: 'done', durationMs: e.durationMs, aborted: e.isAborted })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // Where a changed file sits for the explorer: the session's folder when it
    // is inside it, else the repository holding it, else its own folder, with
    // each folder listed from there down.
    const placeOf = async (file: string): Promise<GitloguePlace | undefined> => {
      const home = (await $.env.get('HOME')) ?? ''
      const folder = parentOf(file)
      let root: string | undefined
      if (cwd && cwd !== home && file.startsWith(cwd + '/')) root = cwd
      for (let dir = folder; !root && dir !== '/' && dir !== home; dir = parentOf(dir))
        if (await $.fs.exists(dir + '/.git').catch(() => false)) root = dir
      root ??= folder
      const listings: Record<string, DirEntry[]> = {}
      for (const dir of chainTo(root, file)) {
        const entries = await $.fs.list(dir).catch(() => undefined)
        if (!entries) return undefined
        listings[dir] = entries
          .filter(entry => entry.name !== '.git')
          .slice(0, 400)
          .map(entry => ({ name: entry.name, dir: entry.kind === 'dir' }))
      }
      return { root, listings }
    }
    const editOf = async (file: string, before: string, after: string, created: boolean): Promise<PlayerEvent> => ({
      type: 'edit',
      path: display(file),
      before,
      after,
      created,
      file,
      place: await placeOf(file).catch(() => undefined),
    })

    if (e.tool === 'Bash') {
      const command = String((e as { command?: unknown }).command ?? '')
      const description = (e as { description?: unknown }).description
      const startedAt = Date.now()
      enqueue({ type: 'command', command, description: typeof description === 'string' ? description : undefined, startedAt })

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
      const shellCwd = await $.session.cwd()
      // The plugins' store is written by this mod itself while commands run.
      const isOwn = (path: string) => path.startsWith(home + '/.claude/plugins/store/')
      const fetched = downloadTargets(command, shellCwd, home)
      const paths = candidatePaths(command, shellCwd, home).filter(path => !isOwn(path) && !fetched.includes(path))
      const before = new Map<string, string | null>()
      // What existed before, of any kind, to see what the command removes.
      const existed = new Map<string, 'file' | 'dir' | 'other'>()
      await Promise.all(
        paths.map(async path => {
          const stat = await $.fs.stat(path).catch(() => undefined)
          if (stat) existed.set(path, stat.kind)
          const text = await look(path).catch(() => undefined)
          if (text !== undefined) before.set(path, text)
        }),
      )

      const ran = await next(e)
      const durationMs = Date.now() - startedAt

      const edits: PlayerEvent[] = []
      const seen = new Set<string>(fetched)
      if (ran.deny === undefined && ran.isError !== true)
        for (const file of fetched) {
          const stat = await $.fs.stat(file).catch(() => undefined)
          if (stat?.kind !== 'file') continue
          edits.push({
            type: 'download',
            path: display(file),
            file,
            bytes: stat.size,
            durationMs,
            place: await placeOf(file).catch(() => undefined),
          })
        }
      for (const [path, old] of before) {
        const now = await look(path).catch(() => undefined)
        if (typeof now !== 'string' || now === old) continue
        seen.add(path)
        edits.push(await editOf(path, old ?? '', now, old === null))
      }
      // What the engine saw the command change, for files the command never names.
      const result = 'result' in ran ? (ran.result as { bashEditDiff?: { files?: BashEditFile[] } } | undefined) : undefined
      for (const file of result?.bashEditDiff?.files ?? []) {
        if (file.deleted || seen.has(file.filePath) || isOwn(file.filePath)) continue
        const now = await look(file.filePath).catch(() => undefined)
        if (typeof now !== 'string') continue
        const old = file.created ? '' : reverseApply(now, file.hunks)
        if (old !== now) edits.push(await editOf(file.filePath, old, now, file.created === true))
      }
      // What the command removed, outermost only: a folder's files go with it.
      const gone: string[] = []
      for (const [path, kind] of existed)
        if (!(await $.fs.exists(path).catch(() => true))) gone.push(path + (kind === 'dir' ? '/' : ''))
      for (const path of gone.sort()) {
        const file = path.replace(/\/$/, '')
        if (gone.some(other => other !== path && other.endsWith('/') && file.startsWith(other))) continue
        edits.push({ type: 'delete', path: display(file), file, isDir: path.endsWith('/'), place: await placeOf(file).catch(() => undefined) })
      }
      edits.forEach(enqueue)

      // A search through code or for file names, as the editor would run it.
      const search = searchOf(command, shellCwd, home)
      const output = ran.deny ?? ran.text ?? ''
      if (search?.kind === 'code') {
        const only = search.paths.length === 1 ? display(search.paths[0]) : undefined
        const { hits, total } = hitsOf(output, only)
        enqueue({ type: 'codesearch', query: search.query, hits: hits.map(hit => ({ ...hit, path: display(hit.path) })), total })
      } else if (search?.kind === 'files') {
        const files = output.split('\n').map(line => line.trim()).filter(line => line && !/^Exit code/.test(line))
        enqueue({ type: 'findfiles', pattern: search.pattern, files: files.map(display) })
      }

      // A commit or push, as git reports it.
      const git = ('result' in ran ? (ran.result as { gitOperation?: { commit?: { sha: string; branch?: string }; push?: { branch: string } } } | undefined) : undefined)?.gitOperation
      if (git?.commit || git?.push) {
        let root: string | undefined
        for (let dir = shellCwd; dir && dir !== '/'; dir = parentOf(dir))
          if (await $.fs.exists(dir + '/.git').catch(() => false)) {
            root = dir
            break
          }
        enqueue({
          type: 'git',
          commit: git.commit ? { ...git.commit, message: commitMessageOf(command, output) } : undefined,
          push: git.push,
          root,
          durationMs,
        })
      }

      const text = ran.deny ?? ran.text ?? ''
      const exit = /^Exit code (\d+)/m.exec(text)
      const all = text
        .split('\n')
        .map(line => line.trimEnd())
        .filter(line => line.trim() !== '' && !/^Exit code \d+$/.test(line))
      enqueue({
        type: 'output',
        lines: all.slice(0, 3),
        total: all.length,
        failed: ran.deny !== undefined || ran.isError === true,
        exitCode: exit ? Number(exit[1]) : undefined,
        durationMs,
      })
      return ran
    }

    if (e.tool === 'WebSearch') {
      const query = String((e as { query?: unknown }).query ?? '')
      const startedAt = Date.now()
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError === true) return ran
      const result = ran.result as { results?: (string | { content?: GitlogueLink[] })[]; durationSeconds?: number } | undefined
      const results = (result?.results ?? []).flatMap(part => (typeof part === 'string' ? [] : (part.content ?? [])))
      const durationMs = result?.durationSeconds !== undefined ? result.durationSeconds * 1000 : Date.now() - startedAt
      enqueue({ type: 'search', query, results, durationMs })
      return ran
    }

    if (e.tool === 'WebFetch') {
      const url = String((e as { url?: unknown }).url ?? '')
      const startedAt = Date.now()
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError === true) return ran
      const result = ran.result as { result?: string; url?: string; durationMs?: number } | undefined
      enqueue({
        type: 'fetch',
        url: result?.url ?? url,
        text: (result?.result ?? ran.text ?? '').slice(0, 20000),
        durationMs: result?.durationMs ?? Date.now() - startedAt,
      })
      return ran
    }

    if (e.tool === 'Read') {
      const ran = await next(e)
      const result = 'result' in ran ? (ran.result as { type?: string; file?: { dimensions?: Record<string, number | undefined>; startLine?: number; numLines?: number; content?: string } } | undefined) : undefined
      if (result?.type === 'text') {
        const file = String((e as { file_path?: unknown }).file_path ?? '')
        const whole = await $.fs.read(file).catch(() => undefined)
        if (typeof whole === 'string' && !whole.includes('\u0000'))
          enqueue({
            type: 'read',
            path: display(file),
            file,
            text: whole,
            startLine: result.file?.startLine ?? 1,
            numLines: result.file?.numLines ?? whole.split('\n').length,
            place: await placeOf(file).catch(() => undefined),
          })
        return ran
      }
      if (result?.type !== 'image') return ran
      const file = String((e as { file_path?: unknown }).file_path ?? '')
      // The terminal shows PNGs; anything else is shown through a PNG copy.
      let png = file
      if (!/\.png$/i.test(file)) {
        const home = (await $.env.get('HOME')) ?? '/tmp'
        const stat = await $.fs.stat(file).catch(() => undefined)
        png = `${home}/.cache/gitlogue/${hashOf(file + ':' + (stat?.mtimeMs ?? 0))}.png`
        if (!(await $.fs.exists(png).catch(() => false))) {
          await $.process.run(['mkdir', '-p', parentOf(png)]).catch(() => undefined)
          const made = await $.process.run(['magick', file + '[0]', '-resize', '1600x1600>', 'png:' + png]).catch(() => undefined)
          if (made?.exitCode !== 0) return ran
        }
      }
      let width = result.file?.dimensions?.originalWidth ?? 0
      let height = result.file?.dimensions?.originalHeight ?? 0
      if (!width || !height) {
        const size = await $.process.run(['magick', 'identify', '-format', '%w %h', png]).catch(() => undefined)
        ;[width, height] = (size?.stdout ?? '0 0').split(' ').map(Number)
      }
      if (width > 0 && height > 0)
        enqueue({ type: 'image', path: display(file), file, png, width, height, place: await placeOf(file).catch(() => undefined) })
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
    if (after !== undefined && after !== before) enqueue(await editOf(path, before ?? '', after, before === undefined))
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (e.surface !== 'terminal') return <Text dimColor>gitlogue draws in the terminal.</Text>
    const { Raster, Image } = $.ui.resolve(e)

    const width = Math.min(512, e.props.bodyColumns)
    const height = Math.min(256, e.props.scroll.bodyRows)
    if (width < 20 || height < 4) {
      mounted = undefined
      return <Text dimColor>gitlogue needs more room.</Text>
    }
    // The phone takes the pane's left, the replay the rest.
    const phoneWidth = chatOption ? Math.min(64, Math.max(40, Math.floor(width * 0.34))) : 0
    phoneShown = phoneWidth
    const layout = layoutFor(width - (phoneWidth ? phoneWidth + 1 : 0), height)
    mounted = layout
    shownTurn = player.turnVersion
    shownScene = player.sceneVersion
    const frame = frames(layout)
    sent = { tree: frame.tree, main: frame.main }
    schedule()

    const turn = player.turn
    const picture = player.screen === 'image' && player.image ? imageBox(layout, player.image) : undefined
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

    // With the chat up, the prompt is already in it: the turn's changes stand
    // where the commit message would.
    const touched = turn ? [...player.files.values()].filter(entry => entry.turn === turn.id) : []
    const summary = touched.length === 0
      ? 'no files changed yet'
      : `${touched.length} file${touched.length === 1 ? '' : 's'}  +${touched.reduce((n, f) => n + f.added, 0)} -${touched.reduce((n, f) => n + f.deleted, 0)}`
    const info = turn
      ? [
          label('turn: ', turn.id, theme.statusHash),
          label('author: ', 'Claude', theme.statusAuthor),
          label('date: ', turn.date, theme.statusDate),
          ...(isChatOn() ? [label('changes: ', summary, theme.fileTreeModified)] : []),
          ...(isChatOn() ? '' : turn.prompt)
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

    const { Markdown } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" width={width} height={height}>
        {phoneWidth > 0 && drawPhone({ Box, Text, Markdown }, chat, theme, hex, phoneWidth, height)}
        {phoneWidth > 0 && <Box width={1} />}
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
        <Box width={layout.rightWidth} height={height}>
          <Raster key="main" columns={layout.rightWidth} rows={height} cells={frame.main} />
          {picture && player.image && (
            <Box position="absolute" top={picture.top} left={picture.left}>
              <Image
                key="picture"
                source={{ file: player.image.png, format: 'png' }}
                columns={picture.columns}
                rows={picture.rows}
                alt={player.image.path}
              />
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}
