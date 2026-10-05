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

// The command with its simple `NAME=value` assignments substituted.
function expandVars(command: string, cwd: string, home: string): string {
  const vars = new Map<string, string>([['HOME', home], ['PWD', cwd]])
  for (const m of command.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g))
    vars.set(m[1], unquote(m[2]))
  return command.replace(/\$\{(\w+)\}|\$(\w+)/g, (all, a: string | undefined, b: string | undefined) => {
    const value = vars.get(a ?? b ?? '')
    return value ?? all
  })
}

function resolver(home: string) {
  return (word: string, base: string) => {
    if (word.startsWith('~/')) return normalize(home + word.slice(1))
    if (word.startsWith('/')) return normalize(word)
    return normalize(base + '/' + word)
  }
}

// Absolute paths of every word in the command that could name a file: an
// argument (`sed -i s/a/b/ notes.md`), a redirect target (`> out.json`), or a
// name inside an inline script (`open('register.tsx', 'w')`), resolved against
// the working directory and every directory the command `cd`s into, with
// simple `NAME=value` assignments substituted.
export function candidatePaths(command: string, cwd: string, home: string): string[] {
  const expanded = expandVars(command, cwd, home)
  const resolve = resolver(home)

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

const DOWNLOADERS = new Set(['curl', 'wget', 'aria2c'])

const urlName = (url: string) => {
  const name = url.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() ?? ''
  return name.includes('.') || name.length > 0 ? decodeURIComponent(name) : 'index.html'
}

// The files a command downloads to: curl's -o/-O, wget's -O or the address's
// name, aria2c's -o, each under the folder the command was in or asked for.
export function downloadTargets(command: string, cwd: string, home: string): string[] {
  const resolve = resolver(home)
  const out: string[] = []
  let dir = cwd
  for (const segment of expandVars(command, cwd, home).split(/&&|\|\||;|\n|\|/)) {
    const words = [...segment.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map(m => unquote(m[0]))
    while (words.length > 0 && (/^\w+=/.test(words[0]) || words[0] === 'sudo' || words[0] === 'command')) words.shift()
    const tool = (words[0] ?? '').split('/').pop() ?? ''
    if (tool === 'cd' && words[1]) dir = resolve(words[1], dir)
    if (!DOWNLOADERS.has(tool)) continue
    let into = dir
    let named: string | undefined
    let remote = tool !== 'curl'
    const urls: string[] = []
    // The flag naming the output file, and the one naming its folder, per tool.
    const nameFlags = { curl: ['-o', '--output'], wget: ['-O', '--output-document'], aria2c: ['-o', '--out'] }[tool] ?? []
    const dirFlags = { curl: ['--output-dir'], wget: ['-P', '--directory-prefix'], aria2c: ['-d', '--dir'] }[tool] ?? []
    for (let i = 1; i < words.length; i++) {
      const word = words[i]
      if (/^https?:\/\//.test(word)) {
        urls.push(word)
        continue
      }
      const long = word.match(/^(--[\w-]+)(?:=(.*))?$/)
      if (long) {
        const value = long[2] ?? (nameFlags.includes(long[1]) || dirFlags.includes(long[1]) ? words[++i] : undefined)
        if (nameFlags.includes(long[1])) named = value
        else if (dirFlags.includes(long[1])) into = value ?? into
        else if (tool === 'curl' && long[1] === '--remote-name') remote = true
        continue
      }
      // A cluster of short flags (`-sSLO`, `-qO-`): the last may take a value.
      const short = word.match(/^-([A-Za-z]+)(.*)$/)
      if (!short) continue
      if (tool === 'curl' && short[1].includes('O')) remote = true
      const last = '-' + short[1].slice(-1)
      const value = short[2] !== '' ? short[2] : nameFlags.includes(last) || dirFlags.includes(last) ? words[++i] : undefined
      if (nameFlags.includes(last)) named = value
      else if (dirFlags.includes(last)) into = value ?? into
    }
    if (named === '-') continue
    if (named) out.push(resolve(named, resolve(into, dir)))
    else if (remote) for (const url of urls) out.push(resolve(urlName(url), resolve(into, dir)))
  }
  return [...new Set(out)]
}

const GREPS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack'])
const FINDERS = new Set(['fd', 'fdfind', 'find'])

export type ShellSearch =
  | { kind: 'code'; query: string; paths: string[] }
  | { kind: 'files'; pattern: string }

// The search a command runs, when it is one: grep and its kin over code, or
// fd and find over file names; read from the first such command in it.
export function searchOf(command: string, cwd: string, home: string): ShellSearch | undefined {
  const resolve = resolver(home)
  let dir = cwd
  for (const segment of expandVars(command, cwd, home).split(/&&|\|\||;|\n|\|/)) {
    const words = [...segment.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map(m => unquote(m[0]))
    while (words.length > 0 && (/^\w+=/.test(words[0]) || words[0] === 'sudo' || words[0] === 'command')) words.shift()
    let tool = (words[0] ?? '').split('/').pop() ?? ''
    if (tool === 'cd' && words[1]) dir = resolve(words[1], dir)
    if (tool === 'git' && words[1] === 'grep') {
      words.shift()
      tool = 'grep'
    }
    if (GREPS.has(tool)) {
      let query: string | undefined
      const paths: string[] = []
      for (let i = 1; i < words.length; i++) {
        const word = words[i]
        if (word === '-e' || word === '--regexp') query ??= words[++i]
        else if (word.startsWith('--regexp=')) query ??= word.slice(9)
        else if (/^-(A|B|C|m|-max-count|-context|-glob|g|t|-type)$/.test(word)) i++
        else if (word.startsWith('-')) continue
        else if (query === undefined) query = word
        else paths.push(resolve(word, dir))
      }
      if (query) return { kind: 'code', query, paths }
    }
    if (FINDERS.has(tool)) {
      let pattern: string | undefined
      for (let i = 1; i < words.length; i++) {
        const word = words[i]
        if (tool === 'find') {
          // The name asked for, not a path excluded or included around it.
          if (/^-i?name$/.test(word)) pattern ??= words[++i]
          else if (/^-i?(path|regex)$/.test(word) && words[i - 1] !== '-not' && words[i - 1] !== '!') pattern ??= words[++i]
        } else if (/^-(e|t|d|E|-extension|-type|-max-depth|-exclude)$/.test(word)) i++
        else if (!word.startsWith('-') && pattern === undefined) pattern = word
      }
      if (pattern) return { kind: 'files', pattern }
    }
  }
  return undefined
}

// A grep-like command's output as matches by file: `path:line:text` lines,
// `line:text` ones when it searched one file, and bare paths when it listed
// files only.
export function hitsOf(output: string, onlyPath: string | undefined): { hits: { path: string; matches: { line: number; text: string }[] }[]; total: number } {
  const byPath = new Map<string, { line: number; text: string }[]>()
  let total = 0
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || /^Exit code \d+$/.test(line)) continue
    const full = /^(.+?):(\d+):(.*)$/.exec(line)
    const single = /^(\d+):(.*)$/.exec(line)
    if (full) {
      byPath.set(full[1], [...(byPath.get(full[1]) ?? []), { line: Number(full[2]), text: full[3] ?? '' }])
      total++
    } else if (single && onlyPath) {
      byPath.set(onlyPath, [...(byPath.get(onlyPath) ?? []), { line: Number(single[1]), text: single[2] ?? '' }])
      total++
    } else if (!line.includes(':') && /[./]/.test(line)) {
      if (!byPath.has(line)) byPath.set(line, [])
    }
  }
  return { hits: [...byPath].map(([path, matches]) => ({ path, matches })), total }
}

// A commit's message as the command gives it with -m, else as git reports it.
export function commitMessageOf(command: string, output: string): string | undefined {
  const flag = /(?:^|\s)-m\s+("([^"]*)"|'([^']*)'|(\S+))/.exec(command)
  if (flag) return (flag[2] ?? flag[3] ?? flag[4] ?? '').split('\n')[0]
  return /^\[[^\]]+\] (.+)$/m.exec(output)?.[1]
}
