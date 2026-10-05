// While the replay pane is open, the conversation beside it reads as a chat
// on a phone, the way two colleagues message: the person's lines in green on
// the right, marked read; Claude's on the left under its mascot; the tool work
// left to the pane; a typing line while Claude works.

import type { On } from 'claude-code'

import type { Theme } from './themes'

const CLAUDE = '#d77757'
const MINE = '#06c755'
const INK_ON_MINE = '#0a0a0a'
// Claude Code's mascot, as its welcome banner draws it.
const MASCOT = [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  ']
const AVATAR_WIDTH = 10
const PHONE_WIDTH = 64

export const CHAT_TONE = [
  'The person is reading this conversation as a LINE-style chat on a phone screen,',
  'while your tool work is replayed in a pane beside it, as if messaging a colleague',
  'who sits next to them. Write each reply the way a colleague texts: short, plain',
  "sentences in the person's language; no headings, tables or long lists unless they",
  'ask for them; let the pane show the work instead of narrating it.',
].join(' ')

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
  return Math.min(room, longest + 2)
}

const two = (n: number) => String(n).padStart(2, '0')

export function registerChat(on: On, ctx: { isOn: () => boolean; theme: Theme; hex: (color: number) => string }) {
  // When each row was first drawn, as the chat's time stamp for it.
  const stamps = new Map<string, string>()
  const stampOf = (id: string) => {
    let stamp = stamps.get(id)
    if (!stamp) {
      const now = new Date()
      stamp = `${two(now.getHours())}:${two(now.getMinutes())}`
      stamps.set(id, stamp)
      if (stamps.size > 2000) stamps.delete(stamps.keys().next().value as string)
    }
    return stamp
  }
  // The phone's column within the transcript: centred, at most a phone wide.
  const column = (columns: number | undefined) => {
    const width = Math.max(30, (columns ?? 80) - 2)
    const phone = Math.min(width, PHONE_WIDTH)
    return { phone, margin: Math.floor((width - phone) / 2) }
  }

  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    if (!ctx.isOn() || e.props.isExpanded || e.surface !== 'terminal') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const { phone, margin } = column(e.viewport?.columns)
    const text = e.props.text.trim()
    // Messages from the system, a task or another agent sit centred, as notices do.
    if (e.props.task || e.props.from) {
      const line = text.split('\n')[0] ?? ''
      return (
        <Box paddingLeft={margin} width={margin + phone} justifyContent="center">
          <Text dimColor wrap="truncate-end">
            {line}
          </Text>
        </Box>
      )
    }
    const width = bubbleWidth(text, Math.floor(phone * 0.72), false)
    return (
      <Box paddingLeft={margin} width={margin + phone} flexDirection="row" justifyContent="flex-end" alignItems="flex-end">
        <Box flexDirection="column" alignItems="flex-end" marginRight={1}>
          <Text dimColor>已读</Text>
          <Text dimColor>{stampOf(e.requestId)}</Text>
        </Box>
        <Box width={width} paddingX={1} backgroundColor={MINE}>
          <Text color={INK_ON_MINE} backgroundColor={MINE}>
            {text}
          </Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (!ctx.isOn() || e.surface !== 'terminal') return next(e)
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const { phone, margin } = column(e.viewport?.columns)
    const bubble = ctx.hex(ctx.theme.editorCursorLineBg)
    const width = bubbleWidth(e.props.text, Math.floor(phone * 0.78) - AVATAR_WIDTH, true)
    const first = e.props.isFirstOfReply
    return (
      <Box paddingLeft={margin} width={margin + phone} flexDirection="row">
        <Box width={AVATAR_WIDTH} flexDirection="column">
          {first && MASCOT.map(row => <Text color={CLAUDE}>{row}</Text>)}
        </Box>
        <Box flexDirection="column">
          {first && <Text color={ctx.hex(ctx.theme.fileTreeCurrentFileFg)}>Claude</Text>}
          <Box flexDirection="row" alignItems="flex-end">
            <Box width={width} paddingX={1} backgroundColor={bubble}>
              <Markdown text={e.props.text} />
            </Box>
            <Box marginLeft={1}>
              <Text dimColor>{stampOf(e.requestId)}</Text>
            </Box>
          </Box>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Spinner' }, ($, e, next) => {
    if (!ctx.isOn() || e.surface !== 'terminal') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const { margin } = column(e.viewport?.columns)
    const doing =
      e.props.mode === 'thinking' ? '正在思考…' : e.props.mode === 'tool-use' || e.props.mode === 'tool-input' ? '正在操作…' : '正在输入…'
    return (
      <Box paddingLeft={margin} flexDirection="row">
        <Box width={AVATAR_WIDTH}>
          <Text color={CLAUDE}>{MASCOT[1]}</Text>
        </Box>
        <Box paddingX={1} backgroundColor={ctx.hex(ctx.theme.editorCursorLineBg)}>
          <Text>···</Text>
        </Box>
        <Text dimColor> Claude {doing}</Text>
      </Box>
    )
  })

  // The tool work is the pane's to show; its rows step aside while the chat is up.
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

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!ctx.isOn()) return composed
    return { sections: [...composed.sections, { id: 'gitlogue:chat', text: CHAT_TONE, scope: 'session' as const }] }
  })
}
