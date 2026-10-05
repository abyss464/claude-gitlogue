// A line-at-a-time syntax highlighter: one token class per character, with the
// state a line ends in (inside a block comment or a multi-line string) carried
// to the next. The classes are the ones gitlogue's themes color.

export const Tok = {
  Variable: 0,
  Keyword: 1,
  Type: 2,
  Function: 3,
  String: 4,
  Number: 5,
  Comment: 6,
  Operator: 7,
  Punctuation: 8,
  Constant: 9,
  Parameter: 10,
  Property: 11,
  Label: 12,
} as const
export type Tok = (typeof Tok)[keyof typeof Tok]

type Lang = {
  lineComments: string[]
  blockComments: [string, string][]
  // Delimiters whose strings may run past the end of a line.
  multilineStrings: string[]
  strings: string[]
  keywords: Set<string>
  constants: Set<string>
  types: Set<string>
  caseInsensitive?: boolean
  hashCommentNeedsSpace?: boolean
  rustLifetimes?: boolean
  macros?: boolean
  sigils?: string
  decorators?: boolean
  preprocessor?: boolean
  keysBeforeColon?: boolean
  keysBeforeEquals?: boolean
  markup?: boolean
  markdown?: boolean
  identChars?: RegExp
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean))

const C_COMMENTS = { lineComments: ['//'], blockComments: [['/*', '*/']] as [string, string][] }
const NONE = { lineComments: [], blockComments: [] as [string, string][], multilineStrings: [], strings: [] }

const JS: Lang = {
  ...C_COMMENTS,
  multilineStrings: ['`'],
  strings: ['"', "'"],
  keywords: words(`break case catch class const continue debugger default delete do else export extends
    finally for from function if import in instanceof let new of return static super switch this throw try
    typeof var void while with yield async await as interface type enum implements declare namespace
    readonly private public protected abstract keyof infer is satisfies get set`),
  constants: words('true false null undefined NaN Infinity'),
  types: words('string number boolean any unknown never object symbol bigint'),
  decorators: true,
}

const RUST: Lang = {
  ...C_COMMENTS,
  multilineStrings: ['"'],
  strings: [],
  keywords: words(`as async await break const continue crate dyn else enum extern fn for if impl in let loop
    match mod move mut pub ref return self static struct super trait type unsafe use where while`),
  constants: words('true false'),
  types: words('i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str Self'),
  rustLifetimes: true,
  macros: true,
}

const PYTHON: Lang = {
  lineComments: ['#'],
  blockComments: [],
  multilineStrings: ['"""', "'''"],
  strings: ['"', "'"],
  keywords: words(`and as assert async await break class continue def del elif else except finally for from
    global if import in is lambda nonlocal not or pass raise return try while with yield match case self cls`),
  constants: words('True False None'),
  types: words('int str float bool list dict set tuple bytes object complex frozenset type'),
  decorators: true,
}

const GO: Lang = {
  ...C_COMMENTS,
  multilineStrings: ['`'],
  strings: ['"', "'"],
  keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import
    interface map package range return select struct switch type var`),
  constants: words('true false nil iota'),
  types: words(`int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64
    complex64 complex128 string bool byte rune error any`),
}

const C_FAMILY: Lang = {
  ...C_COMMENTS,
  multilineStrings: [],
  strings: ['"', "'"],
  keywords: words(`auto break case const continue default do else enum extern for goto if inline register
    restrict return sizeof static struct switch typedef union volatile while class namespace template
    typename public private protected virtual override final new delete this throw try catch using operator
    constexpr noexcept static_cast dynamic_cast reinterpret_cast const_cast friend explicit mutable`),
  constants: words('true false NULL nullptr'),
  types: words(`void char short int long float double signed unsigned bool size_t ssize_t int8_t int16_t
    int32_t int64_t uint8_t uint16_t uint32_t uint64_t auto`),
  preprocessor: true,
}

const JVM_FAMILY: Lang = {
  ...C_COMMENTS,
  multilineStrings: ['"""'],
  strings: ['"', "'"],
  keywords: words(`abstract assert break case catch class const continue default do else enum extends final
    finally for if implements import instanceof interface native new package private protected public return
    static super switch synchronized this throw throws transient try volatile while var val fun when object
    companion data sealed open override lateinit is in out by init let func struct protocol extension guard
    defer where namespace using async await yield dynamic late required get set internal def lazy match trait
    with typealias inout mutating operator record`),
  constants: words('true false null nil'),
  types: words('void boolean byte char short int long float double string bool dynamic Int String Bool'),
  decorators: true,
}

const SHELL: Lang = {
  lineComments: ['#'],
  blockComments: [],
  multilineStrings: ['"', "'"],
  strings: [],
  keywords: words(`if then else elif fi for while until do done case esac in function return local export
    readonly declare set unset source alias exit shift trap break continue select time end begin not and or
    switch`),
  constants: words('true false'),
  types: words(''),
  hashCommentNeedsSpace: true,
  sigils: '$',
}

const RUBY: Lang = {
  lineComments: ['#'],
  blockComments: [['=begin', '=end']],
  multilineStrings: [],
  strings: ['"', "'"],
  keywords: words(`alias and begin break case class def defined do else elsif end ensure for if in module
    next not or redo rescue retry return self super then undef unless until when while yield require
    require_relative attr_accessor attr_reader attr_writer private protected public include extend`),
  constants: words('true false nil'),
  types: words(''),
  sigils: '@',
}

const LUA: Lang = {
  lineComments: ['--'],
  blockComments: [['--[[', ']]']],
  multilineStrings: ['[['],
  strings: ['"', "'"],
  keywords: words(`and break do else elseif end for function goto if in local not or repeat return then
    until while`),
  constants: words('true false nil'),
  types: words(''),
}

const SQL: Lang = {
  lineComments: ['--'],
  blockComments: [['/*', '*/']],
  multilineStrings: [],
  strings: ["'", '"'],
  keywords: words(`select from where and or not insert into values update set delete create table drop alter
    add column index primary key foreign references join inner left right outer full on as group by order
    having limit offset union all distinct case when then else end is null in exists between like begin
    commit rollback transaction view trigger function returns return declare if with default unique check
    constraint asc desc`),
  constants: words('true false null'),
  types: words('int integer bigint smallint text varchar char boolean bool date timestamp float real numeric decimal serial uuid json jsonb'),
  caseInsensitive: true,
}

const HASKELL: Lang = {
  lineComments: ['--'],
  blockComments: [['{-', '-}']],
  multilineStrings: [],
  strings: ['"'],
  keywords: words(`case class data default deriving do else if import in infix infixl infixr instance let
    module newtype of then type where qualified as hiding forall`),
  constants: words('True False Nothing'),
  types: words(''),
}

const NIX: Lang = {
  lineComments: ['#'],
  blockComments: [['/*', '*/']],
  multilineStrings: ["''", '"'],
  strings: [],
  keywords: words('let in with rec inherit if then else import assert or'),
  constants: words('true false null'),
  types: words(''),
  keysBeforeEquals: true,
}

const ELIXIR: Lang = {
  lineComments: ['#'],
  blockComments: [],
  multilineStrings: ['"""'],
  strings: ['"', "'"],
  keywords: words(`def defp defmodule defmacro defstruct defimpl defprotocol do end if else unless case cond
    fn when with for receive try catch rescue after raise import alias require use quote unquote and or not in`),
  constants: words('true false nil'),
  types: words(''),
  sigils: '@',
}

const ZIG: Lang = {
  lineComments: ['//'],
  blockComments: [],
  multilineStrings: [],
  strings: ['"', "'"],
  keywords: words(`const var fn pub return if else while for switch break continue defer errdefer try catch
    struct enum union error comptime inline export extern test and or orelse unreachable async await`),
  constants: words('true false null undefined'),
  types: words('i8 i16 i32 i64 u8 u16 u32 u64 usize isize f32 f64 bool void anytype type noreturn'),
}

const YAML: Lang = {
  lineComments: ['#'],
  blockComments: [],
  multilineStrings: [],
  strings: ['"', "'"],
  keywords: words(''),
  constants: words('true false null yes no on off'),
  types: words(''),
  hashCommentNeedsSpace: true,
  keysBeforeColon: true,
  identChars: /[A-Za-z0-9_\-.]/,
}

const TOML: Lang = {
  lineComments: ['#', ';'],
  blockComments: [],
  multilineStrings: ['"""', "'''"],
  strings: ['"', "'"],
  keywords: words(''),
  constants: words('true false'),
  types: words(''),
  keysBeforeEquals: true,
  identChars: /[A-Za-z0-9_\-.]/,
}

const JSON_LANG: Lang = {
  ...C_COMMENTS,
  multilineStrings: [],
  strings: ['"'],
  keywords: words(''),
  constants: words('true false null'),
  types: words(''),
  keysBeforeColon: true,
}

const CSS: Lang = {
  ...C_COMMENTS,
  multilineStrings: [],
  strings: ['"', "'"],
  keywords: words('important from to and not only'),
  constants: words(''),
  types: words(''),
  keysBeforeColon: true,
  sigils: '@$',
  identChars: /[A-Za-z0-9_\-]/,
}

const MARKUP: Lang = {
  lineComments: [],
  blockComments: [['<!--', '-->']],
  multilineStrings: [],
  strings: ['"', "'"],
  keywords: words(''),
  constants: words(''),
  types: words(''),
  markup: true,
  identChars: /[A-Za-z0-9_\-:.]/,
}

const MARKDOWN: Lang = {
  ...NONE,
  blockComments: [['<!--', '-->']],
  keywords: words(''),
  constants: words(''),
  types: words(''),
  markdown: true,
}

const PLAIN: Lang = {
  ...NONE,
  strings: ['"'],
  keywords: words(''),
  constants: words(''),
  types: words(''),
}

const BY_EXTENSION: Record<string, Lang> = {}
const assign = (lang: Lang, exts: string) => exts.split(' ').forEach(ext => (BY_EXTENSION[ext] = lang))
assign(JS, 'js jsx mjs cjs ts tsx mts cts')
assign(RUST, 'rs')
assign(PYTHON, 'py pyi pyw')
assign(GO, 'go')
assign(C_FAMILY, 'c h cc cpp cxx hpp hh hxx m mm ino glsl hlsl wgsl shader gdshader')
assign(JVM_FAMILY, 'java kt kts scala sc swift dart cs groovy gradle php gd')
assign(SHELL, 'sh bash zsh fish ksh envrc')
assign(RUBY, 'rb rake gemspec')
assign(LUA, 'lua')
assign(SQL, 'sql')
assign(HASKELL, 'hs lhs elm purs')
assign(NIX, 'nix')
assign(ELIXIR, 'ex exs erl hrl')
assign(ZIG, 'zig')
assign(YAML, 'yaml yml')
assign(TOML, 'toml ini cfg conf tres tscn godot properties editorconfig')
assign(JSON_LANG, 'json jsonc json5 webmanifest')
assign(CSS, 'css scss sass less')
assign(MARKUP, 'html htm xml svg vue svelte astro xhtml plist xaml')
assign(MARKDOWN, 'md markdown mdx')

const BY_NAME: Record<string, Lang> = {
  Makefile: SHELL,
  makefile: SHELL,
  Dockerfile: SHELL,
  Justfile: SHELL,
  justfile: SHELL,
  PKGBUILD: SHELL,
  '.bashrc': SHELL,
  '.zshrc': SHELL,
  '.profile': SHELL,
  'CMakeLists.txt': SHELL,
  '.gitignore': YAML,
}

export function languageFor(path: string): Lang {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (BY_NAME[name]) return BY_NAME[name]
  const dot = name.lastIndexOf('.')
  return (dot >= 0 && BY_EXTENSION[name.slice(dot + 1).toLowerCase()]) || PLAIN
}

export type LineTokens = { toks: Uint8Array; end: string }

const LONG_LINE = 2000
const IDENT_START = /[A-Za-z_]/
const IDENT = /[A-Za-z0-9_]/
const DIGIT = /[0-9]/
const OPERATORS = '+-*/%=<>!&|^~?:'
const PUNCTUATION = '()[]{},;.'
const DEFINERS = words('fn def func function fun sub proc macro')

function nextNonSpace(line: string, from: number): string {
  for (let i = from; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return line[i]
  return ''
}

function prevNonSpace(line: string, before: number): string {
  for (let i = before - 1; i >= 0; i--) if (line[i] !== ' ' && line[i] !== '\t') return line[i]
  return ''
}

function previousWord(line: string, before: number): string {
  let i = before - 1
  while (i >= 0 && line[i] === ' ') i--
  const end = i + 1
  while (i >= 0 && IDENT.test(line[i])) i--
  return line.slice(i + 1, end)
}

// The state a line starts in: '' plain, 'c<close>' in a block comment, 's<delim>' in a string.
function tokenize(lang: Lang, line: string, start: string): LineTokens {
  const toks = new Uint8Array(line.length)
  const n = line.length
  let i = 0
  let state = start
  const fill = (from: number, to: number, tok: Tok) => toks.fill(tok, from, Math.min(to, n))
  const identChar = lang.identChars ?? IDENT

  if (lang.markdown && state === '') {
    const heading = /^(#{1,6})\s/.exec(line)
    if (heading) return { toks: toks.fill(Tok.Keyword), end: '' }
    if (/^\s*```/.test(line)) return { toks: toks.fill(Tok.Comment), end: 's```' }
    if (/^\s*>/.test(line)) return { toks: toks.fill(Tok.Comment), end: '' }
    const list = /^(\s*)([-*+]|\d+\.)\s/.exec(line)
    if (list) fill(list[1].length, list[1].length + list[2].length, Tok.Punctuation)
  }

  while (i < n) {
    if (state.startsWith('c')) {
      const close = state.slice(1)
      const at = line.indexOf(close, i)
      if (at < 0) {
        fill(i, n, Tok.Comment)
        return { toks, end: state }
      }
      fill(i, at + close.length, Tok.Comment)
      i = at + close.length
      state = ''
      continue
    }
    if (state.startsWith('s')) {
      const delim = state.slice(1)
      let at = -1
      for (let j = i; j < n; j++) {
        if (line[j] === '\\' && delim !== "''" && delim !== '```') {
          j++
          continue
        }
        if (line.startsWith(delim, j)) {
          at = j
          break
        }
      }
      if (at < 0) {
        fill(i, n, delim === '```' ? Tok.Comment : Tok.String)
        return { toks, end: state }
      }
      fill(i, at + delim.length, delim === '```' ? Tok.Comment : Tok.String)
      i = at + delim.length
      state = ''
      continue
    }

    const ch = line[i]

    const lineComment = lang.lineComments.find(
      c =>
        line.startsWith(c, i) &&
        !(lang.blockComments.some(([open]) => line.startsWith(open, i) && open.startsWith(c))) &&
        !(c === '#' && lang.hashCommentNeedsSpace && i > 0 && !/\s/.test(line[i - 1])) &&
        !(c === '#' && lang.sigils?.includes('$') && line[i - 1] === '$'),
    )
    if (lineComment) {
      fill(i, n, Tok.Comment)
      return { toks, end: '' }
    }
    const block = lang.blockComments.find(([open]) => line.startsWith(open, i) && (open !== '=begin' || i === 0))
    if (block) {
      fill(i, i + block[0].length, Tok.Comment)
      i += block[0].length
      state = 'c' + block[1]
      continue
    }
    if (lang.markdown && line.startsWith('`', i)) {
      const close = line.indexOf('`', i + 1)
      const to = close < 0 ? n : close + 1
      fill(i, to, Tok.String)
      i = to
      continue
    }
    if (lang.markdown) {
      const link = /^\[[^\]]*\]\([^)]*\)/.exec(line.slice(i))
      if (link) {
        const label = link[0].indexOf('](')
        fill(i, i + label + 1, Tok.Function)
        fill(i + label + 1, i + link[0].length, Tok.String)
        i += link[0].length
        continue
      }
      const emphasis = /^(\*\*|__|\*|_)(?=\S)(.+?)\1/.exec(line.slice(i))
      if (emphasis && (i === 0 || !IDENT.test(line[i - 1]))) {
        fill(i, i + emphasis[0].length, Tok.Type)
        i += emphasis[0].length
        continue
      }
      i++
      continue
    }
    const multi = lang.multilineStrings.find(d => line.startsWith(d, i))
    if (multi && !(lang.rustLifetimes && multi === "'")) {
      fill(i, i + multi.length, Tok.String)
      i += multi.length
      state = 's' + multi
      continue
    }
    if (lang.rustLifetimes && ch === "'") {
      const charLiteral = /^'(\\.[^']*|[^'\\])'/.exec(line.slice(i))
      if (charLiteral) {
        fill(i, i + charLiteral[0].length, Tok.String)
        i += charLiteral[0].length
        continue
      }
      const lifetime = /^'[A-Za-z_]\w*/.exec(line.slice(i))
      if (lifetime) {
        fill(i, i + lifetime[0].length, Tok.Label)
        i += lifetime[0].length
        continue
      }
    }
    if (lang.strings.includes(ch)) {
      let j = i + 1
      while (j < n && line[j] !== ch) j += line[j] === '\\' ? 2 : 1
      const to = Math.min(n, j + 1)
      const isKey = lang.keysBeforeColon && nextNonSpace(line, to) === ':'
      fill(i, to, isKey ? Tok.Property : Tok.String)
      i = to
      continue
    }
    if (lang.markup && ch === '<') {
      const tag = /^<\/?([A-Za-z][\w\-:.]*)/.exec(line.slice(i))
      if (tag) {
        fill(i, i + 1 + (tag[0][1] === '/' ? 1 : 0), Tok.Punctuation)
        fill(i + tag[0].length - tag[1].length, i + tag[0].length, Tok.Keyword)
        i += tag[0].length
        continue
      }
    }
    if (lang.preprocessor && ch === '#' && prevNonSpace(line, i) === '') {
      const directive = /^#\s*\w+/.exec(line.slice(i))
      if (directive) {
        fill(i, i + directive[0].length, Tok.Keyword)
        i += directive[0].length
        continue
      }
    }
    if (lang.decorators && ch === '@' && i + 1 < n && IDENT_START.test(line[i + 1])) {
      let j = i + 1
      while (j < n && /[\w.]/.test(line[j])) j++
      fill(i, j, Tok.Function)
      i = j
      continue
    }
    if (lang.sigils?.includes(ch) && i + 1 < n && /[\w{(@#?!*]/.test(line[i + 1])) {
      let j = i + 1
      if (line[j] === '{' || line[j] === '(') {
        const close = line[j] === '{' ? '}' : ')'
        const at = line.indexOf(close, j)
        j = at < 0 ? n : at + 1
      } else {
        j++
        while (j < n && /\w/.test(line[j])) j++
      }
      fill(i, j, ch === '$' ? Tok.Parameter : Tok.Property)
      i = j
      continue
    }
    if ((DIGIT.test(ch) || (ch === '.' && DIGIT.test(line[i + 1] ?? ''))) && (i === 0 || !identChar.test(line[i - 1]))) {
      let j = i + 1
      while (j < n && /[0-9a-fA-FxXoObB_.]/.test(line[j])) {
        if (line[j] === '.' && !DIGIT.test(line[j + 1] ?? '')) break
        j++
      }
      if (/[eE]/.test(line[j - 1] ?? '') && /[+-]/.test(line[j] ?? '')) {
        j++
        while (j < n && DIGIT.test(line[j])) j++
      }
      while (j < n && /[a-zA-Z]/.test(line[j])) j++
      fill(i, j, Tok.Number)
      i = j
      continue
    }
    if (IDENT_START.test(ch) || (lang.identChars && identChar.test(ch) && !DIGIT.test(ch) && ch !== '-' && ch !== '.')) {
      let j = i + 1
      while (j < n && identChar.test(line[j])) j++
      const word = line.slice(i, j)
      const key = lang.caseInsensitive ? word.toLowerCase() : word
      const after = nextNonSpace(line, j)
      const before = prevNonSpace(line, i)
      let tok: Tok
      if (lang.markup) {
        tok = after === '=' ? Tok.Property : Tok.Variable
      } else if (lang.keysBeforeColon && after === ':' && line[j + 1] !== ':') {
        tok = Tok.Property
      } else if (lang.keysBeforeEquals && after === '=' && line[j + 1] !== '=') {
        tok = Tok.Property
      } else if (lang.keywords.has(key)) {
        tok = Tok.Keyword
      } else if (lang.constants.has(key) || (/^[A-Z][A-Z0-9_]+$/.test(word) && word.length > 1)) {
        tok = Tok.Constant
      } else if (lang.macros && line[j] === '!' && line[j + 1] !== '=') {
        tok = Tok.Function
        j++
      } else if (after === '(' || DEFINERS.has(previousWord(line, i))) {
        tok = Tok.Function
      } else if (before === '.' || line.startsWith('->', i - 2)) {
        tok = Tok.Property
      } else if (lang.types.has(key) || /^[A-Z]/.test(word)) {
        tok = Tok.Type
      } else {
        tok = Tok.Variable
      }
      fill(i, j, tok)
      i = j
      continue
    }
    if (OPERATORS.includes(ch)) toks[i] = Tok.Operator
    else if (PUNCTUATION.includes(ch)) toks[i] = Tok.Punctuation
    i++
  }
  return { toks, end: state }
}

// Highlights a buffer's lines, remembering each line's result by its text and
// the state it starts in, so a frame re-tokenizes only the lines that changed.
export class Highlighter {
  private cache = new Map<string, LineTokens>()
  private lang: Lang = PLAIN
  private states: string[] = ['']
  private valid = 0

  setPath(path: string) {
    this.lang = languageFor(path)
    this.cache.clear()
    this.invalidate(0)
  }

  invalidate(fromLine: number) {
    this.valid = Math.min(this.valid, fromLine)
  }

  line(lines: string[], index: number): Uint8Array {
    while (this.valid < index) {
      this.states[this.valid + 1] = this.run(lines[this.valid] ?? '', this.states[this.valid] ?? '').end
      this.valid++
    }
    return this.run(lines[index] ?? '', this.states[index] ?? '').toks
  }

  private run(text: string, start: string): LineTokens {
    // A very long line colors its head only, and is never kept.
    if (text.length > LONG_LINE) {
      const head = tokenize(this.lang, text.slice(0, LONG_LINE), start)
      const toks = new Uint8Array(text.length)
      toks.set(head.toks)
      return { toks, end: head.end }
    }
    const key = start + '\u0000' + text
    let hit = this.cache.get(key)
    if (!hit) {
      if (this.cache.size > 20000) this.cache.clear()
      hit = tokenize(this.lang, text, start)
      this.cache.set(key, hit)
    }
    return hit
  }
}
