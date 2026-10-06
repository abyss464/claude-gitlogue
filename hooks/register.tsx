// gitlogue for Claude Code: replays every change Claude makes the way gitlogue
// replays a commit, typed into an editor in a pane beside the conversation.
// A turn is the commit: its prompt is the message, the files it touches form
// the tree, the commands it runs scroll through the terminal.

import type { Register } from 'claude-code'

import type { GitlogueLink, GitloguePlace, GitlogueSaved, GitlogueCapture } from '../types'

import { candidatePaths, commitMessageOf, downloadTargets, hitsOf, reverseApply, searchOf, type EngineHunk } from './bashfiles'
import { chainTo, parentOf, type DirEntry } from './explorer'
import { Chat, drawPhone, registerChat } from './chat'
import { languageOf, speak, words } from './i18n'
import { DEFAULT_COLOR, imageBox, layoutFor, paint, type Layout, type WideRun } from './frame'
import { Player, type PlayerEvent } from './player'
import { DEFAULT_THEME, THEMES } from './themes'

const PANE = 'gitlogue'
const SAVED = { plugin: 'gitlogue', key: 'saved' } as const
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const FAST_TICK_MS = 33
const BLINK_MS = 500
const MAX_SNAPSHOT_BYTES = 1_000_000
// The tools of the server that gives Claude screens of its own.
const SCREENS_TOOL = 'mcp__hypr-screens__'
// Recordings play at twice their speed or faster, at most this many frames a second.
const CAST_SPEED = 2
const CAST_FPS_LIMIT = 30
const CAST_LONGEST_PLAY_SECONDS = 8
// Commands that grab screens, and those that make pictures out of pictures
// (frames from a clip, a sheet of frames): from captures, they are captures.
const GRABBING = /(^|[\s;&|(])(grim|import|scrot|spectacle|gnome-screenshot|hyprshot|flameshot|wf-recorder)\b|x11grab|kmsgrab/
const KEPT_CAPTURES = 40
// The shape a chat is kept in; one kept in another is read again.
const CHAT_FORMAT = 2
const TRANSCRIPT_READ =
  'f=$(ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$1".jsonl 2>/dev/null | head -n 1); [ -n "$f" ] && jq -c "$2" "$f" 2>/dev/null'
// The person's prompts (typed, or sent while Claude worked) and Claude's
// words, from a transcript file: one {role, text} per line.
const TRANSCRIPT_CHAT = `
  if .isSidechain == true or .isMeta == true or .isCompactSummary == true then empty
  elif .type == "user" then
    (.message.content | if type == "string" then . else ([.[]? | select(.type == "text") | .text] | join("\\n")) end) as $text
    | select(($text | length) > 0 and ([.message.content | arrays | .[] | select(.type == "tool_result")] | length) == 0)
    | {role: "user", text: $text}
  elif .type == "attachment" and .attachment.type == "queued_command" and .attachment.origin.kind == "human" then
    (.attachment.prompt | if type == "string" then . else ([.[]? | select(.type == "text") | .text] | join("\\n")) end) as $text
    | select($text | length > 0) | {role: "user", text: $text}
  elif .type == "assistant" then
    ([.message.content[]? | select(.type == "text") | .text] | join("\\n")) as $text
    | select($text | length > 0) | {role: "assistant", text: $text}
  else empty end`
const DERIVING = /(^|[\s;&|(])(magick|montage|convert|ffmpeg)\b/
// With the chat in it, the pane asks to take nearly the whole width: the
// transcript beside it has nothing left to show.
const WIDE_DOCK = 400
// The replays kept for /resume: the newest few sessions, each within a share of
// the 4 MiB store.
const KEPT_SESSIONS = 3
const MAX_RECORD_CHARS = 1_000_000
// A session's chat as kept for /resume, beside its replay: the newest lines
// within this many characters (the session itself holds all of them).
const MAX_CHAT_CHARS = 200_000
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
  const languageOption = String(options.language ?? 'auto')

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
  // Recordings of Claude's own screens, when the hypr-screens server is here:
  // the pane marks that it watches, finds new clips, and plays them.
  let castEnabled = false
  let runtimeDir = ''
  let viewerMark = ''
  let lastMark = 0
  let lastPoll = 0
  let isDecoding = false
  let shownCastFrame: string | undefined
  const seenClips = new Set<string>()
  // Where and when commands left screen captures (screenshots, frames, sheets
  // tiled from them): looking at one shows what a recording already shows.
  // Kept with the session's state, so a reload remembers them.
  const captures: GitlogueCapture[] = []
  let capturesChanged = false
  let shownChat = -1
  let lastTick = Date.now()
  let sent = { tree: '', main: '', wide: '' }
  let isBlitting = false
  let timer: { cancel: () => void } | undefined
  let timerMs = 0

  const display = (path: string) =>
    cwd && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path

  const frames = (layout: Layout) => {
    const canvas = paint(player, theme, layout, Math.floor(Date.now() / BLINK_MS) % 2 === 0)
    const treeRows = layout.bottomRows > 0 ? layout.topRows + 1 : layout.height
    const treeWide = layout.leftWidth > 0 ? canvas.wideRuns(0, 0, layout.leftWidth, treeRows) : []
    const mainWide = canvas.wideRuns(layout.leftWidth, 0, layout.rightWidth, layout.height)
    return {
      treeRows,
      tree: layout.leftWidth > 0 ? canvas.encode(0, 0, layout.leftWidth, treeRows) : '',
      main: canvas.encode(layout.leftWidth, 0, layout.rightWidth, layout.height),
      treeWide,
      mainWide,
      // Wide characters are drawn as text in the tree: a change to them redraws it.
      wide: JSON.stringify([treeWide, mainWide]),
    }
  }

  // The clock that plays the script, and the record that outlives a reload of
  // this module, set up where the session's engine is in reach.
  let schedule = () => {}
  let persist = () => {}
  let resume = async (_id: string) => {}

  // Replay: every event the pane plays and every change to the phone, kept
  // per session with its time, so `/gitlogue replay` plays a session again
  // as it ran. Pictures and screen recordings are copied beside the log,
  // since the originals change or are removed once played.
  type ReplayEntry = { at: number; kind: 'event' | 'chat'; op?: 'add' | 'read' | 'working'; data?: unknown }
  let replayDir = ''
  let replayFile = ''
  let replayLog: ReplayEntry[] = []
  let replaying = false
  let savePending = false
  // Set up where the session's engine is in reach, as `schedule` is.
  let saveLog = () => {}
  let runCopy = (_argv: string[]) => {}
  let replay = async (_id: string): Promise<string> => words.notStarted
  const record = (entry: Omit<ReplayEntry, 'at'>) => {
    if (replaying || !replayFile) return
    let data = entry.data as PlayerEvent
    if (entry.kind === 'event' && (data.type === 'cast' || data.type === 'image')) {
      const keep = `${replayDir}/assets/${Date.now().toString(36)}-${replayLog.length}`
      if (data.type === 'cast') {
        runCopy(['sh', '-c', 'mkdir -p "$1" && cp "$@" "$1"/ 2>/dev/null; true', 'sh', keep, ...data.frames])
        data = { ...data, frames: data.frames.map(f => `${keep}/${f.slice(f.lastIndexOf('/') + 1)}`), remove: [] }
      } else {
        runCopy(['sh', '-c', 'mkdir -p "$(dirname "$2")" && cp "$1" "$2"', 'sh', data.png, `${keep}.png`])
        data = { ...data, png: `${keep}.png` }
      }
    }
    replayLog.push({ at: Date.now(), ...entry, data })
    saveLog()
  }

  const enqueue = (event: PlayerEvent) => {
    record({ kind: 'event', data: event })
    player.enqueue(event)
    if (!mounted) player.flush()
    schedule()
    persist()
  }

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    // The pane's language: the option, else Claude Code's, else the locale's.
    const setting = (await $.settings.read().catch(() => ({}) as Record<string, unknown>)).language
    const locale =
      (await $.env.get('LC_ALL').catch(() => undefined)) ||
      (await $.env.get('LC_MESSAGES').catch(() => undefined)) ||
      (await $.env.get('LANG').catch(() => undefined))
    speak(
      languageOf(languageOption === 'auto' ? undefined : languageOption) ??
        languageOf(typeof setting === 'string' ? setting : undefined) ??
        languageOf(locale ?? undefined) ??
        'en',
    )
    replayDir = `${(await $.env.get('HOME')) ?? '/tmp'}/.cache/gitlogue/replays`
    await $.process.run(['mkdir', '-p', `${replayDir}/assets`]).catch(() => undefined)
    runtimeDir = (await $.env.get('XDG_RUNTIME_DIR')) ?? ''
    // Nothing of the screen recordings loads unless their server is connected.
    castEnabled = (await $.tool.list().catch(() => [])).some(tool => tool.name.startsWith(SCREENS_TOOL))
    lastTick = Date.now()

    let session = await $.session.id()
    // A resumed session keeps adding to the log it already has.
    const openLog = async (id: string) => {
      replayFile = `${replayDir}/${id}.jsonl`
      const kept = await $.fs.read(replayFile).catch(() => '')
      replayLog = String(kept)
        .split('\n')
        .filter(Boolean)
        .flatMap(line => {
          try {
            return [JSON.parse(line) as ReplayEntry]
          } catch {
            return []
          }
        })
    }
    await openLog(session)
    saveLog = () => {
      if (savePending || !replayFile) return
      savePending = true
      $.clock.after(1000, () => {
        savePending = false
        void $.fs.write(replayFile, replayLog.map(entry => JSON.stringify(entry)).join('\n') + '\n').catch(() => {})
      })
    }
    runCopy = argv => {
      void $.process.run(argv).catch(() => undefined)
    }
    // Plays a session's log again from its start, at the pace it was recorded.
    replay = async (id: string) => {
    let file = id ? `${replayDir}/${id.replace(/\.jsonl$/, '')}.jsonl` : ''
    if (!file) {
      const logs = (await $.fs.list(replayDir).catch(() => []))
        .filter(entry => entry.name.endsWith('.jsonl') && `${replayDir}/${entry.name}` !== replayFile)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
      if (!logs.length) return words.nothingRecorded
      file = `${replayDir}/${logs[0].name}`
    }
    const text = await $.fs.read(file).catch(() => undefined)
    if (typeof text !== 'string') return words.noReplayLog(file)
    const entries = text
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as ReplayEntry]
        } catch {
          return []
        }
      })
    if (!entries.length) return `${file} is empty.`
    replaying = true
    player.reset()
    chat.restore([])
    chatWorking(false)
    if (!mounted) await $.ui.open({ id: PANE, title: 'gitlogue', rows: 24, ...(chatOption ? { columns: WIDE_DOCK } : {}) })
    const t0 = entries[0].at
    entries.forEach((entry, i) =>
      $.clock.after(Math.max(1, entry.at - t0 + 1500), () => {
        if (entry.kind === 'event') enqueue(entry.data as PlayerEvent)
        else if (entry.op === 'add') chatAdd(entry.data as Parameters<typeof chatAdd>[0])
        else if (entry.op === 'read') chatRead()
        else if (entry.op === 'working') chatWorking(entry.data === true)
        if (i === entries.length - 1) replaying = false
        $.ui.invalidate('ui.render')
      }),
    )
    return words.replaying(entries.length, file)
    }
    const stored = await $.store.get(RECENT_KEY)
    let recent: string[] = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
    let storedAt = 0

    // The replay as a record small enough to keep: everything still to play,
    // else the panes alone, else the panes without the open file.
    const record = (): GitlogueSaved => {
      // The chat, its oldest lines left out past its share of the store.
      let size = 2
      let start = chat.lines.length
      while (start > 0 && size + JSON.stringify(chat.lines[start - 1]).length + 1 <= MAX_CHAT_CHARS)
        size += JSON.stringify(chat.lines[--start]).length + 1
      const kept = { format: CHAT_FORMAT, lines: chat.lines.slice(start) }
      const full = player.save()
      if (JSON.stringify(full).length <= MAX_RECORD_CHARS) return { ...full, chat: kept }
      const view = player.view()
      const panes = { view, pending: [] }
      if (JSON.stringify(panes).length <= MAX_RECORD_CHARS) return { ...panes, chat: kept }
      return { view: { ...view, lines: [''], hasFile: false, currentPath: null }, pending: [], chat: kept }
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
    let savedChat = -1

    // A session's conversation for the phone, when no chat of it was kept:
    // from its transcript file (found by the session's id, under whichever
    // project folder), which still holds what a compaction dropped, else from
    // the messages the session holds.
    const conversation = async (id: string): Promise<{ role: 'user' | 'assistant'; text: string }[]> => {
      const ran = await $.process
        .run(['sh', '-c', TRANSCRIPT_READ, 'sh', id, TRANSCRIPT_CHAT], { timeoutMs: 60_000 })
        .catch(() => undefined)
      const rows = (ran?.stdout ?? '').split('\n').flatMap(row => {
        try {
          const message = JSON.parse(row) as { role?: unknown; text?: unknown }
          const role = message.role === 'user' || message.role === 'assistant' ? message.role : undefined
          return role && typeof message.text === 'string' ? [{ role: role as 'user' | 'assistant', text: message.text }] : []
        } catch {
          return []
        }
      })
      if (rows.length > 0) return rows
      return id === (await $.session.id()) ? await $.session.messages().catch(() => []) : []
    }
    persist = () => {
      if (player.saveVersion === savedVersion && chat.version === savedChat && !capturesChanged) return
      savedVersion = player.saveVersion
      savedChat = chat.version
      capturesChanged = false
      void $.state.set(SAVED, { ...player.save(), session, captures, chat: { format: CHAT_FORMAT, lines: chat.lines } }).catch(() => {})
      keep()
    }

    // The session's last replay, from a reload of this module (an edit, a
    // changed option) or from an earlier run this session resumes.
    const load = async () => {
      const { value: live } = await $.state.get(SAVED)
      if (live && live.session === session) {
        captures.splice(0, captures.length, ...(live.captures ?? []))
        if (live.chat?.format === CHAT_FORMAT) chat.restore(live.chat.lines)
        else chat.load(await conversation(session))
        return player.restore(live)
      }
      const kept = (await $.store.get(recordKey(session))) as GitlogueSaved | undefined
      if (kept?.chat?.format === CHAT_FORMAT) chat.restore(kept.chat.lines)
      else chat.load(await conversation(session))
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
      await openLog(id)
      const kept = (await $.store.get(recordKey(id))) as GitlogueSaved | undefined
      if (kept?.chat?.format === CHAT_FORMAT) chat.restore(kept.chat.lines)
      else chat.load(await conversation(id))
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
      watchScreens()
      if (player.removals.length > 0) void $.process.run(['rm', '-rf', ...player.removals.splice(0)]).catch(() => {})
      if (player.screen === 'cast' && player.castFrame && player.castFrame !== shownCastFrame) {
        shownCastFrame = player.castFrame
        void $.ui.blit({ requestId: PANE, key: 'cast', source: { file: player.castFrame, format: 'png' } }).catch(() => {})
      }
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
        if (frame.wide !== sent.wide) {
          sent = { ...sent, wide: frame.wide }
          $.ui.invalidate('ui.render')
          schedule()
          return
        }
        const blits: Promise<unknown>[] = []
        if (frame.main !== sent.main)
          blits.push($.ui.blit({ requestId: PANE, key: 'main', cells: frame.main, columns: layout.rightWidth, rows: layout.height }))
        if (frame.tree && frame.tree !== sent.tree)
          blits.push($.ui.blit({ requestId: PANE, key: 'tree', cells: frame.tree, columns: layout.leftWidth, rows: frame.treeRows }))
        sent = { tree: frame.tree, main: frame.main, wide: frame.wide }
        if (blits.length > 0) {
          isBlitting = true
          void Promise.allSettled(blits).then(() => (isBlitting = false))
        }
      }
      schedule()
    }

    // While the pane is open and the screens' server is here: a mark that the
    // pane watches (the server records only while one is fresh), and a look
    // for clips it has finished.
    const watchScreens = () => {
      if (!castEnabled || !mounted || !runtimeDir) return
      const now = Date.now()
      if (now - lastMark > 10_000) {
        lastMark = now
        viewerMark = `${runtimeDir}/hypr-screens/viewers/gitlogue-${session}`
        void $.fs.write(viewerMark, String(now)).catch(() => {})
      }
      if (isDecoding || now - lastPoll < 1000) return
      lastPoll = now
      isDecoding = true
      void takeClips().finally(() => (isDecoding = false))
    }

    // Each new clip, decoded to frames at the speed it plays at, and queued.
    const takeClips = async () => {
      const dir = `${runtimeDir}/hypr-screens/recordings`
      const notes = (await $.fs.list(dir).catch(() => []))
        .map(entry => entry.name)
        .filter(name => name.endsWith('.json') && !seenClips.has(name))
        .sort()
      for (const name of notes) {
        seenClips.add(name)
        const note = JSON.parse(String(await $.fs.read(`${dir}/${name}`).catch(() => '{}'))) as {
          screen?: string
          file?: string
          width?: number
          height?: number
          seconds?: number
        }
        if (!note.file) continue
        const seconds = note.seconds ?? 0
        const speed = Math.max(CAST_SPEED, seconds / CAST_LONGEST_PLAY_SECONDS)
        const fps = Math.min(CAST_FPS_LIMIT, 15 * speed)
        const frames = note.file.replace(/\.mp4$/, '-frames')
        const remove = [note.file, `${dir}/${name}`, frames]
        await $.process.run(['mkdir', '-p', frames]).catch(() => undefined)
        const made = await $.process
          .run(['ffmpeg', '-v', 'error', '-y', '-i', note.file, '-vf', `setpts=PTS/${speed},fps=${fps},scale=1920:-2`, `${frames}/f%04d.png`], { timeoutMs: 120_000 })
          .catch(() => undefined)
        const list = made?.exitCode === 0 ? (await $.fs.list(frames).catch(() => [])).map(entry => entry.name).filter(n => n.endsWith('.png')).sort() : []
        enqueue({
          type: 'cast',
          screen: note.screen ?? '?',
          frames: list.map(n => `${frames}/${n}`),
          fps,
          speed,
          seconds,
          width: note.width ?? 1600,
          height: note.height ?? 1000,
          remove,
        })
      }
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
      description: words.commandDescription,
      argumentHint: '[replay [session-id]]',
    })
    if (openAtStart && e.isInteractive) void $.ui.open({ id: PANE, title: 'gitlogue', rows: 24, ...(chatOption ? { columns: WIDE_DOCK } : {}) })
    // After a reload the pane may still be up, drawn by the module before this one.
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // The words Claude Code closes each turn with (`Cogitated for 1m 57s`), by
  // the turn's length, so the terminal ends the turn in the same words.
  const closingWords = new Map<number, string>()
  player.wordFor = durationMs => {
    let best: string | undefined
    let gap = 2000
    for (const [ms, word] of closingWords) {
      if (Math.abs(ms - durationMs) < gap) {
        gap = Math.abs(ms - durationMs)
        best = word
      }
    }
    return best
  }
  on('ui.render', { component: 'TurnDuration' }, ($, e, next) => {
    closingWords.set(e.props.durationMs, e.props.word)
    if (closingWords.size > 50) closingWords.delete(closingWords.keys().next().value as number)
    if (!isChatOn() || e.surface !== 'terminal') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  const chat = new Chat()
  const chatAdd = chat.add.bind(chat)
  const chatRead = chat.markRead.bind(chat)
  const chatWorking = chat.working.bind(chat)
  let lastWorking: boolean | undefined
  chat.add = line => {
    record({ kind: 'chat', op: 'add', data: line })
    chatAdd(line)
  }
  chat.markRead = () => {
    record({ kind: 'chat', op: 'read' })
    chatRead()
  }
  // While a replay plays, the phone shows the replayed session's work, not this one's.
  chat.working = isWorking => {
    if (replaying) return
    if (isWorking !== lastWorking) record({ kind: 'chat', op: 'working', data: isWorking })
    lastWorking = isWorking
    chatWorking(isWorking)
  }

  registerChat(on, { isOn: isChatOn, chat })

  // /resume inside a running session switches to another one's replay.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'resume') await resume(e.session_id)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__gitlogue__refresh' }, ($, e) => {
    const lift = (e as { chat_scroll?: unknown }).chat_scroll
    if (typeof lift === 'number') chat.scrollTo(lift)
    $.ui.invalidate('ui.render')
    return { result: 'The gitlogue mod is running its latest code; its pane and chat view are redrawn.' }
  })

  on('command.run', { command: 'gitlogue' }, async ($, e) => {
    const args = String((e as { args?: unknown }).args ?? '').trim().split(/\s+/)
    if (args[0] === 'replay') {
      const said = await replay(args[1] ?? '')
      $.ui.toast(said)
      return {}
    }
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
    if (viewerMark) void $.process.run(['rm', '-f', viewerMark]).catch(() => {})
    lastMark = 0
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
    if (String(e.tool).startsWith(SCREENS_TOOL)) castEnabled = true
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
      // Where the command left screen captures, and when.
      const derived =
        DERIVING.test(command) &&
        paths.some(
          path =>
            /\/hypr-screens\/recordings\//.test(path) ||
            captures.some(c => [path, parentOf(path), parentOf(parentOf(path))].some(dir => c.dirs.includes(dir))),
        )
      if (castEnabled && (GRABBING.test(command) || derived)) {
        captures.push({ dirs: [...new Set(paths.flatMap(path => [path, parentOf(path)]))], from: startedAt - 1000, to: Date.now() + 1000 })
        captures.splice(0, Math.max(0, captures.length - KEPT_CAPTURES))
        capturesChanged = true
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
      // Claude's screens are recorded: a capture of one is that recording again.
      if (castEnabled) {
        const stat = await $.fs.stat(file).catch(() => undefined)
        const captured =
          /\/hypr-screens\/recordings\//.test(file) ||
          (stat !== undefined &&
            captures.some(c => (c.dirs.includes(file) || c.dirs.includes(parentOf(file))) && stat.mtimeMs >= c.from && stat.mtimeMs <= c.to))
        if (captured) return ran
      }
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
    if (e.surface !== 'terminal') return <Text dimColor>{words.terminalOnly}</Text>
    const { Raster, Image } = $.ui.resolve(e)

    const width = Math.min(512, e.props.bodyColumns)
    const height = Math.min(256, e.props.scroll.bodyRows)
    if (width < 20 || height < 4) {
      mounted = undefined
      return <Text dimColor>{words.needsRoom}</Text>
    }
    // The phone takes the pane's left, the replay the rest.
    const phoneWidth = chatOption ? Math.min(64, Math.max(40, Math.floor(width * 0.34))) : 0
    phoneShown = phoneWidth
    const layout = layoutFor(width - (phoneWidth ? phoneWidth + 1 : 0), height)
    mounted = layout
    shownTurn = player.turnVersion
    shownScene = player.sceneVersion
    const frame = frames(layout)
    sent = { tree: frame.tree, main: frame.main, wide: frame.wide }
    schedule()

    const turn = player.turn
    const picture = player.screen === 'image' && player.image ? imageBox(layout, player.image) : undefined
    const castBox = player.screen === 'cast' && player.cast && player.castFrame ? imageBox(layout, player.cast) : undefined
    shownCastFrame = castBox ? player.castFrame : undefined
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
      ? words.noChanges
      : `${words.files(touched.length)}  +${touched.reduce((n, f) => n + f.added, 0)} -${touched.reduce((n, f) => n + f.deleted, 0)}`
    const info = turn
      ? [
          label(words.turn, turn.id, theme.statusHash),
          label(words.author, 'Claude', theme.statusAuthor),
          label(words.date, turn.date, theme.statusDate),
          ...(isChatOn() ? [label(words.changes, summary, theme.fileTreeModified)] : []),
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
            {words.noTurn}
          </Text>,
        ]

    // A run of wide characters, over the blanks the Raster keeps for it.
    const color = (value: number) => (value === DEFAULT_COLOR ? undefined : hex(value))
    const wide = (run: WideRun) => (
      <Box position="absolute" top={run.y} left={run.x}>
        <Text color={color(run.fg)} backgroundColor={color(run.bg)} wrap="truncate">
          {run.text}
        </Text>
      </Box>
    )

    const { Markdown } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" width={width} height={height}>
        {phoneWidth > 0 && drawPhone({ Box, Text, Markdown }, chat, theme, hex, phoneWidth, height)}
        {phoneWidth > 0 && <Box width={1} />}
        {layout.leftWidth > 0 && (
          <Box flexDirection="column" width={layout.leftWidth} height={height}>
            <Box width={layout.leftWidth} height={frame.treeRows} flexShrink={0}>
              <Raster key="tree" columns={layout.leftWidth} rows={frame.treeRows} cells={frame.tree} />
              {frame.treeWide.map(wide)}
            </Box>
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
          {frame.mainWide.map(wide)}
          {castBox && player.castFrame && (
            <Box position="absolute" top={castBox.top} left={castBox.left}>
              <Image
                key="cast"
                source={{ file: player.castFrame, format: 'png' }}
                columns={castBox.columns}
                rows={castBox.rows}
                alt={`screen ${player.cast?.screen ?? ''}`}
              />
            </Box>
          )}
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
