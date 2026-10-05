// Line diff between two versions of a file, grouped into unified-diff hunks
// the way `git diff` (three lines of context) groups them.

export type HunkLine = { kind: 'ctx' | 'del' | 'add'; text: string }
export type Hunk = { oldStart: number; lines: HunkLine[] }

const CONTEXT = 3
const MAX_EDIT_DISTANCE = 4000

type Op = { kind: HunkLine['kind']; text: string; oldIndex: number }

// Myers' O((N+M)D) shortest edit script over the middle that differs.
function myers(a: string[], b: string[]): Op[] | undefined {
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= Math.min(max, MAX_EDIT_DISTANCE); d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(a, b, trace, offset, d)
    }
  }
  return undefined
}

function backtrack(a: string[], b: string[], trace: Int32Array[], offset: number, last: number): Op[] {
  const ops: Op[] = []
  let x = a.length
  let y = b.length
  for (let d = last; d >= 0; d--) {
    const v = trace[d]
    const k = x - y
    const prevK =
      k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : v[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      ops.push({ kind: 'ctx', text: a[x], oldIndex: x })
    }
    if (d === 0) break
    if (x === prevX) ops.push({ kind: 'add', text: b[--y], oldIndex: x })
    else ops.push({ kind: 'del', text: a[--x], oldIndex: x })
  }
  return ops.reverse()
}

// Within each run of changes, deletions come before additions, as git prints them.
function normalize(ops: Op[]): Op[] {
  const out: Op[] = []
  let i = 0
  while (i < ops.length) {
    if (ops[i].kind === 'ctx') {
      out.push(ops[i++])
      continue
    }
    const dels: Op[] = []
    const adds: Op[] = []
    while (i < ops.length && ops[i].kind !== 'ctx') (ops[i].kind === 'del' ? dels : adds).push(ops[i++])
    out.push(...dels, ...adds)
  }
  return out
}

export function diffLines(oldLines: string[], newLines: string[]): Hunk[] {
  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++
  let tail = 0
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  )
    tail++
  const a = oldLines.slice(head, oldLines.length - tail)
  const b = newLines.slice(head, newLines.length - tail)
  if (a.length === 0 && b.length === 0) return []

  const middle =
    myers(a, b) ??
    [
      ...a.map((text, i) => ({ kind: 'del' as const, text, oldIndex: i })),
      ...b.map(text => ({ kind: 'add' as const, text, oldIndex: a.length })),
    ]
  const ops: Op[] = [
    ...oldLines.slice(0, head).map((text, i) => ({ kind: 'ctx' as const, text, oldIndex: i })),
    ...normalize(middle).map(op => ({ ...op, oldIndex: op.oldIndex + head })),
    ...oldLines
      .slice(oldLines.length - tail)
      .map((text, i) => ({ kind: 'ctx' as const, text, oldIndex: oldLines.length - tail + i })),
  ]

  const hunks: Hunk[] = []
  let i = 0
  while (i < ops.length) {
    if (ops[i].kind === 'ctx') {
      i++
      continue
    }
    const start = Math.max(0, i - CONTEXT)
    let end = i
    // Extend over changes, merging ones whose context would touch.
    for (;;) {
      while (end < ops.length && ops[end].kind !== 'ctx') end++
      let gap = end
      while (gap < ops.length && ops[gap].kind === 'ctx') gap++
      if (gap < ops.length && gap - end <= CONTEXT * 2) end = gap
      else break
    }
    const stop = Math.min(ops.length, end + CONTEXT)
    const slice = ops.slice(start, stop)
    hunks.push({ oldStart: slice[0].oldIndex + 1, lines: slice.map(({ kind, text }) => ({ kind, text })) })
    i = stop
  }
  return hunks
}

export function countChanges(hunks: Hunk[]): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const hunk of hunks)
    for (const line of hunk.lines) {
      if (line.kind === 'add') added++
      else if (line.kind === 'del') deleted++
    }
  return { added, deleted }
}
