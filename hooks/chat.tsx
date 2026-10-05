// While the replay pane is open, the conversation moves into it as a phone
// chat, the way two colleagues message: the person's lines in green on the
// right, marked read; Claude's on the left under its mascot; a typing line
// while Claude works. The transcript's own rows step aside, so the pane holds
// the whole picture: the phone, and the work it talks about beside it.

import type { On } from 'claude-code'

import type { Theme } from './themes'

const CLAUDE = '#d77757'
const MINE = '#06c755'
const INK_ON_MINE = '#0a0a0a'
const THEIRS = 0x334455
const BAR = 0x2a3040
const FIELD = 0x3a4256
// Claude Code's mascot, as its welcome banner draws it.
const MASCOT = [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  ']
const AVATAR_WIDTH = 10
const KEPT_MESSAGES = 60

export type ChatLine = { role: 'me' | 'claude'; text: string; time?: string }

const isWide = (cp: number) =>
  cp > 0xffff ||
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6)

function cellWidth(text: string): number {
  let width = 0
  for (const ch of text) width += isWide(ch.codePointAt(0)!) ? 2 : 1
  return width
}

// How wide a bubble for `text` is: its longest line, within the room.
function bubbleWidth(text: string, room: number, isMarkdown: boolean): number {
  if (isMarkdown && /```|^\s*\|/m.test(text)) return room
  const longest = Math.max(1, ...text.split('\n').map(line => cellWidth(line.replace(/[*_`#>]/g, ''))))
  return Math.max(4, Math.min(room, longest + 2))
}

const two = (n: number) => String(n).padStart(2, '0')
const now = () => {
  const d = new Date()
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

// What a user row says to the person: the typed text, without the tags the
// engine wraps its own notes and commands in.
const spoken = (text: string) =>
  text
    .replace(/<(system-reminder|command-[\w-]+|local-command-[\w-]+|task-notification)>[\s\S]*?<\/\1>/g, '')
    .trim()

export class Chat {
  lines: ChatLine[] = []
  isWorking = false
  version = 0

  add(line: ChatLine) {
    if (!line.text.trim()) return
    this.lines.push(line)
    if (this.lines.length > KEPT_MESSAGES * 2) this.lines.splice(0, this.lines.length - KEPT_MESSAGES)
    this.version++
  }

  // The conversation so far, read back whenever the mod loads (a reload, a
  // resumed session), so the phone opens on it.
  load(messages: readonly { role: 'user' | 'assistant'; text: string }[]) {
    this.lines = []
    for (const message of messages) {
      const text = message.role === 'user' ? spoken(message.text) : message.text.trim()
      if (text) this.add({ role: message.role === 'user' ? 'me' : 'claude', text })
    }
  }

  working(isWorking: boolean) {
    if (this.isWorking === isWorking) return
    this.isWorking = isWorking
    this.version++
  }
}

// The phone: a top bar, the latest messages filling up from the bottom (the
// oldest cut off above, as a chat scrolled to its end), and the input bar.
export function drawPhone(
  el: { Box: any; Text: any; Markdown: any },
  chat: Chat,
  theme: Theme,
  hex: (color: number) => string,
  width: number,
  height: number,
) {
  const { Box, Text, Markdown } = el
  const screen = hex(theme.backgroundLeft)
  const bar = hex(BAR)
  const room = width - 2
  const messages = chat.lines.slice(-KEPT_MESSAGES).map((line, i, all) => {
    if (line.role === 'me') {
      const bubble = bubbleWidth(line.text, Math.floor(room * 0.75), false)
      return (
        <Box flexDirection="row" justifyContent="flex-end" alignItems="flex-end" marginTop={1} flexShrink={0}>
          <Box flexDirection="column" alignItems="flex-end" marginRight={1}>
            <Text dimColor>已读</Text>
            {line.time && <Text dimColor>{line.time}</Text>}
          </Box>
          <Box flexDirection="column" width={bubble}>
            <Text color={MINE}>{'▗' + '▄'.repeat(bubble - 2) + '▖'}</Text>
            <Box width={bubble} paddingX={1} backgroundColor={MINE}>
              <Text color={INK_ON_MINE}>{line.text}</Text>
            </Box>
            <Text color={MINE}>{'▝' + '▀'.repeat(bubble - 2) + '▘'}</Text>
          </Box>
          <Box flexDirection="column" width={1} alignSelf="flex-start">
            <Text> </Text>
            <Text color={MINE}>◥</Text>
          </Box>
        </Box>
      )
    }
    const first = all[i - 1]?.role !== 'claude'
    const fill = hex(THEIRS)
    const bubble = bubbleWidth(line.text, room - AVATAR_WIDTH - 8, true)
    return (
      <Box flexDirection="row" marginTop={first ? 1 : 0} flexShrink={0}>
        <Box width={AVATAR_WIDTH} flexDirection="column">
          {first && MASCOT.map(row => <Text color={CLAUDE}>{row}</Text>)}
        </Box>
        <Box flexDirection="column">
          {first && <Text dimColor>Claude</Text>}
          <Box flexDirection="row" alignItems="flex-end">
            <Box flexDirection="column" width={1} alignSelf="flex-start">
              <Text> </Text>
              <Text color={fill}>{first ? '◤' : ' '}</Text>
            </Box>
            <Box flexDirection="column" width={bubble}>
              <Text color={fill}>{'▗' + '▄'.repeat(bubble - 2) + '▖'}</Text>
              <Box width={bubble} paddingX={1} backgroundColor={fill}>
                <Markdown text={line.text.slice(0, 9000)} />
              </Box>
              <Text color={fill}>{'▝' + '▀'.repeat(bubble - 2) + '▘'}</Text>
            </Box>
            {line.time && (
              <Box marginLeft={1}>
                <Text dimColor>{line.time}</Text>
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    )
  })
  if (chat.isWorking)
    messages.push(
      <Box flexDirection="row" marginTop={1} flexShrink={0}>
        <Box width={AVATAR_WIDTH}>
          <Text color={CLAUDE}>{MASCOT[1]}</Text>
        </Box>
        <Box paddingX={1} backgroundColor={hex(THEIRS)}>
          <Text>···</Text>
        </Box>
        <Text dimColor> 正在输入…</Text>
      </Box>,
    )

  return (
    <Box width={width} height={height} flexDirection="column" backgroundColor={screen}>
      <Box width={width} backgroundColor={bar} paddingX={1} flexDirection="row" flexShrink={0}>
        <Text dimColor>‹ </Text>
        <Text bold>Claude</Text>
        <Box flexGrow={1} />
        <Text dimColor>☏ ≡</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column" justifyContent="flex-end" overflow="hidden" paddingX={1}>
        {messages}
      </Box>
      <Box width={width} backgroundColor={bar} flexDirection="row" paddingX={1} flexShrink={0}>
        <Text dimColor>＋ ◎ ▣ </Text>
        <Box flexGrow={1} backgroundColor={hex(FIELD)} paddingX={1}>
          <Text dimColor>Aa</Text>
        </Box>
        <Text dimColor> ☺ ♪</Text>
      </Box>
    </Box>
  )
}

export function registerChat(on: On, ctx: { isOn: () => boolean; chat: Chat }) {
  const { chat } = ctx

  // What the person sends, at once, idle or mid-turn.
  on('prompt.submit', ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      const images = e.attachments?.length ? ` [${e.attachments.length} 张图片]` : ''
      chat.add({ role: 'me', text: e.text.trim() + images, time: now() })
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Each block of Claude's reply as it is stored.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.door === 'response' && e.agentId === undefined && e.message.role === 'assistant') {
      const text = e.message.content
        .flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
        .join('\n')
        .trim()
      if (text) {
        chat.add({ role: 'claude', text, time: now() })
        $.ui.invalidate('ui.render')
      }
    }
    return stored
  })

  // The transcript's own rows step aside while the phone holds the conversation.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    if (!ctx.isOn() || e.props.isExpanded || e.surface !== 'terminal') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (!ctx.isOn() || e.surface !== 'terminal') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })
  on('ui.render', { component: 'Spinner' }, ($, e, next) => {
    if (!ctx.isOn() || e.surface !== 'terminal') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })
  on('ui.render', { component: 'InfoNotice' }, ($, e, next) => {
    if (!ctx.isOn() || e.surface !== 'terminal') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    if (!ctx.isOn() || e.surface !== 'terminal') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (!ctx.isOn() || e.surface !== 'terminal') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })
  on('ui.render', { component: 'ToolProgress' }, ($, e, next) => {
    if (!ctx.isOn() || e.surface !== 'terminal') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    if (!ctx.isOn() || e.props.isExpanded || e.surface !== 'terminal') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })
}
