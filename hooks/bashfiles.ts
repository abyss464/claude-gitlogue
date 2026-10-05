// Which files a shell command may write, read off the command itself, and how
// to recover a file's previous text from the hunks the engine reports.

const MAX_CANDIDATES = 80

function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

function unquote(word: string): string {
  return word.replace(/^(['"])(.*)\1$/, '$2')
}

// Absolute paths of every word in the command that could name a file: an
// argument (`sed -i s/a/b/ notes.md`), a redirect target (`> out.json`), or a
// name inside an inline script (`open('register.tsx', 'w')`), resolved against
// the working directory and every directory the command `cd`s into, with
// simple `NAME=value` assignments substituted.
export function candidatePaths(command: string, cwd: string, home: string): string[] {
  const vars = new Map<string, string>([['HOME', home], ['PWD', cwd]])
  for (const m of command.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g))
    vars.set(m[1], unquote(m[2]))
  const expanded = command.replace(/\$\{(\w+)\}|\$(\w+)/g, (all, a: string | undefined, b: string | undefined) => {
    const value = vars.get(a ?? b ?? '')
    return value ?? all
  })

  const resolve = (word: string, base: string) => {
    if (word.startsWith('~/')) return normalize(home + word.slice(1))
    if (word.startsWith('/')) return normalize(word)
    return normalize(base + '/' + word)
  }

  const bases = [cwd]
  for (const m of expanded.matchAll(/(?:^|[\s;&|(])cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) {
    const dir = resolve(unquote(m[1]), cwd)
    if (!bases.includes(dir)) bases.push(dir)
  }

  const out = new Set<string>()
  for (const m of expanded.matchAll(/[^\s'"`;&|<>(){}[\],=:*?]+/g)) {
    const word = m[0]
    if (word.length < 2 || word.length > 300 || word.startsWith('-')) continue
    if (!/[./]/.test(word) || /^[./]+$/.test(word) || /^\d+(\.\d+)*$/.test(word)) continue
    const isAnchored = word.startsWith('/') || word.startsWith('~/')
    for (const base of isAnchored ? [cwd] : bases) {
      out.add(resolve(word, base))
      if (out.size >= MAX_CANDIDATES) return [...out]
    }
  }
  return [...out]
}

export type EngineHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

// Undoes unified-diff hunks on the file's current text, giving the text before.
export function reverseApply(after: string, hunks: readonly EngineHunk[]): string {
  const endsWithNewline = after.endsWith('\n')
  const lines = (endsWithNewline ? after.slice(0, -1) : after).split('\n')
  if (after === '') lines.length = 0
  for (const hunk of [...hunks].sort((a, b) => b.newStart - a.newStart)) {
    const old = hunk.lines.filter(line => line[0] === ' ' || line[0] === '-').map(line => line.slice(1))
    const at = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1
    lines.splice(Math.max(0, at), hunk.newLines, ...old)
  }
  return lines.length === 0 ? '' : lines.join('\n') + (endsWithNewline ? '\n' : '')
}
