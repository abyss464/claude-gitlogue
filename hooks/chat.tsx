// While the replay pane is open, the conversation beside it reads as a chat
// on a phone, the way two colleagues message: the person's lines in green on
// the right, marked read; Claude's on the left under its mascot; the tool work
// left to the pane; a typing line while Claude works; notices as the small
// centred notes a chat app shows; and the phone's input bar over the prompt.

import type { On } from 'claude-code'

import type { Theme } from './themes'

const CLAUDE = '#d77757'
const MINE = '#06c755'
const INK_ON_MINE = '#0a0a0a'
// Claude Code's mascot, as its welcome banner draws it.
const MASCOT = [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  ']
const AVATAR_WIDTH = 10
const PHONE_WIDTH = 76
const RIGHT_GAP = 4
const THEIRS = 0x334455
const BAR = 0x2a3040
const FIELD = 0x3a4256


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
  // The phone's screen within the transcript: near its right edge, beside the
  // pane, at most a phone wide. The band over the prompt keeps its last few
  // columns for its own mark, so the phone leaves that much room everywhere,
  // and the band lines up by the transcript's width.
  let transcriptColumns = 80
  const column = (columns: number | undefined) => {
    if (columns) transcriptColumns = columns
    const width = Math.max(40, transcriptColumns - RIGHT_GAP)
    const phone = Math.min(width, PHONE_WIDTH)
    return { phone, margin: width - phone }
  }
  const screen = () => ctx.hex(ctx.theme.backgroundLeft)

  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    if (!ctx.isOn() || e.props.isExpanded || e.surface !== 'terminal') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const { phone, margin } = column(e.viewport?.columns)
    const text = e.props.text.trim()
    const bg = screen()
    // Messages from the system, a task or another agent sit centred, as notices do.
    if (e.props.task || e.props.from) {
      return (
        <Box flexDirection="row">
          <Box width={margin} />
          <Box width={phone} backgroundColor={bg} justifyContent="center" paddingY={1}>
            <Text dimColor wrap="truncate-end">
              {text.split('\n')[0] ?? ''}
            </Text>
          </Box>
        </Box>
      )
    }
    const width = bubbleWidth(text, Math.floor(phone * 0.72), false)
    return (
      <Box flexDirection="row">
        <Box width={margin} />
        <Box width={phone} backgroundColor={bg} flexDirection="row" justifyContent="flex-end" alignItems="flex-end" paddingTop={1} paddingRight={1}>
          <Box flexDirection="column" alignItems="flex-end" marginRight={1}>
            <Text dimColor>已读</Text>
            <Text dimColor>{stampOf(e.requestId)}</Text>
          </Box>
          <Box flexDirection="column" width={width}>
            <Text color={MINE}>{'▗' + '▄'.repeat(width - 2) + '▖'}</Text>
            <Box width={width} paddingX={1} backgroundColor={MINE}>
              <Text color={INK_ON_MINE}>{text}</Text>
            </Box>
            <Text color={MINE}>{'▝' + '▀'.repeat(width - 2) + '▘'}</Text>
          </Box>
          <Box flexDirection="column" width={1} alignSelf="flex-start">
            <Text> </Text>
            <Text color={MINE}>◥</Text>
          </Box>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (!ctx.isOn() || e.surface !== 'terminal') return next(e)
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const { phone, margin } = column(e.viewport?.columns)
    const bg = screen()
    const fill = ctx.hex(THEIRS)
    const width = Math.max(4, bubbleWidth(e.props.text, Math.floor(phone * 0.8) - AVATAR_WIDTH - 1, true))
    const first = e.props.isFirstOfReply
    return (
      <Box flexDirection="row">
        <Box width={margin} />
        <Box width={phone} backgroundColor={bg} flexDirection="row" paddingTop={first ? 1 : 0} paddingLeft={1}>
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
              <Box flexDirection="column" width={width}>
                <Text color={fill}>{'▗' + '▄'.repeat(width - 2) + '▖'}</Text>
                <Box width={width} paddingX={1} backgroundColor={fill}>
                  <Markdown text={e.props.text} />
                </Box>
                <Text color={fill}>{'▝' + '▀'.repeat(width - 2) + '▘'}</Text>
              </Box>
              <Box marginLeft={1}>
                <Text dimColor>{stampOf(e.requestId)}</Text>
              </Box>
            </Box>
          </Box>
        </Box>
      </Box>
    )
  })
  on('ui.render', { component: 'Spinner' }, ($, e, next) => {
    if (!ctx.isOn() || e.surface !== 'terminal') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const { phone, margin } = column(e.viewport?.columns)
    const doing =
      e.props.mode === 'thinking' ? '正在思考…' : e.props.mode === 'tool-use' || e.props.mode === 'tool-input' ? '正在操作…' : '正在输入…'
    return (
      <Box flexDirection="row">
        <Box width={margin} />
        <Box width={phone} backgroundColor={screen()} flexDirection="row" paddingTop={1} paddingLeft={1}>
          <Box width={AVATAR_WIDTH}>
            <Text color={CLAUDE}>{MASCOT[1]}</Text>
          </Box>
          <Box paddingX={1} backgroundColor={ctx.hex(THEIRS)}>
            <Text>···</Text>
          </Box>
          <Text dimColor> Claude {doing}</Text>
        </Box>
      </Box>
    )
  })

  // A notice of the engine's (a reload, a setting changed) as a chat app's
  // small centred note.
  on('ui.render', { component: 'InfoNotice' }, ($, e, next) => {
    if (!ctx.isOn() || e.surface !== 'terminal') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const { phone, margin } = column(e.viewport?.columns)
    const line = (e.props.text.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim()
    const room = phone - 6
    return (
      <Box flexDirection="row">
        <Box width={margin} />
        <Box width={phone} backgroundColor={screen()} justifyContent="center" paddingTop={1}>
          <Box paddingX={1} backgroundColor={ctx.hex(BAR)}>
            <Text dimColor>{cellWidth(line) > room ? line.slice(0, room - 1) + '…' : line}</Text>
          </Box>
        </Box>
      </Box>
    )
  })

  // The bottom of the phone, just over the prompt: LINE's input bar.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (!ctx.isOn() || e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const { phone, margin } = column(undefined)
    const bar = ctx.hex(BAR)
    return (
      <Box flexDirection="row">
        <Box width={margin} />
        <Box width={Math.max(10, Math.min(phone, e.props.bodyColumns - margin))} backgroundColor={bar} flexDirection="row" paddingX={1}>
          <Text dimColor>＋ ◎ ▣  </Text>
          <Box flexGrow={1} backgroundColor={ctx.hex(FIELD)} paddingX={1}>
            <Text dimColor>Aa</Text>
          </Box>
          <Text dimColor>  ☺ ♪</Text>
        </Box>
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

}
