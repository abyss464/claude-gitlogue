// The file explorer: workspace roots, the folders opened in them, what each
// folder listed, and where the selection is. The script plans its walks on one
// copy while the panes draw another, both moved by the same operations.

import type { GitlogueDirEntry, GitlogueExplorer } from '../types'

export type DirEntry = GitlogueDirEntry

export type ExplorerRow = {
  path: string
  name: string
  depth: number
  kind: 'root' | 'dir' | 'file' | 'more'
  isOpen: boolean
}

// Rows a folder shows before the rest are folded into one `… N more`.
const FOLDER_ROWS = 24

export const parentOf = (path: string) => path.slice(0, Math.max(1, path.lastIndexOf('/'))) || '/'
export const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path

// The folders from `root` down to the one holding `file`, root first.
export function chainTo(root: string, file: string): string[] {
  const chain = [root]
  const rest = file.slice(root === '/' ? 1 : root.length + 1).split('/').slice(0, -1)
  for (const part of rest) chain.push((chain[chain.length - 1] === '/' ? '' : chain[chain.length - 1]) + '/' + part)
  return chain
}

export class Explorer {
  roots: string[] = []
  expanded = new Set<string>()
  listings = new Map<string, DirEntry[]>()
  selected: string | undefined

  static from(saved: GitlogueExplorer | undefined): Explorer {
    const explorer = new Explorer()
    if (!saved) return explorer
    explorer.roots = saved.roots.slice()
    explorer.expanded = new Set(saved.expanded)
    explorer.listings = new Map(Object.entries(saved.listings).map(([dir, entries]) => [dir, entries.slice()]))
    explorer.selected = saved.selected ?? undefined
    return explorer
  }

  save(): GitlogueExplorer {
    return {
      roots: this.roots.slice(),
      expanded: [...this.expanded],
      listings: Object.fromEntries([...this.listings].map(([dir, entries]) => [dir, entries.slice()])),
      selected: this.selected ?? null,
    }
  }

  clone(): Explorer {
    return Explorer.from(this.save())
  }

  addRoot(root: string) {
    if (!this.roots.includes(root)) this.roots.push(root)
  }

  // A folder's listing as it is now, adding `ensure` when the folder was
  // listed before that file existed (or after it was removed).
  list(dir: string, entries: DirEntry[], ensure?: DirEntry) {
    const byName = new Map(entries.map(entry => [entry.name, entry]))
    if (ensure && !byName.has(ensure.name)) byName.set(ensure.name, ensure)
    const sorted = [...byName.values()].sort((a, b) =>
      a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0,
    )
    this.listings.set(dir, sorted)
  }

  // A name gone from a folder's listing, and the folder closed if it was one.
  unlist(dir: string, name: string) {
    const entries = this.listings.get(dir)
    if (entries) this.listings.set(dir, entries.filter(entry => entry.name !== name))
    const path = (dir === '/' ? '' : dir) + '/' + name
    for (const open of [...this.expanded]) if (open === path || open.startsWith(path + '/')) this.expanded.delete(open)
    if (this.selected === path) this.selected = dir
  }

  // The visible rows; `keep` names paths a long folder must still show.
  rows(keep: ReadonlySet<string>): ExplorerRow[] {
    const rows: ExplorerRow[] = []
    const walk = (dir: string, depth: number) => {
      const entries = this.listings.get(dir) ?? []
      const prefix = dir === '/' ? '' : dir
      const kept = (entry: DirEntry) => {
        const path = prefix + '/' + entry.name
        return keep.has(path) || this.expanded.has(path) || path === this.selected || [...keep].some(k => k.startsWith(path + '/'))
      }
      const shown = entries.length <= FOLDER_ROWS ? entries : entries.filter((entry, i) => i < FOLDER_ROWS - 1 || kept(entry))
      for (const entry of shown) {
        const path = prefix + '/' + entry.name
        const isOpen = entry.dir && this.expanded.has(path)
        rows.push({ path, name: entry.name, depth, kind: entry.dir ? 'dir' : 'file', isOpen })
        if (isOpen) walk(path, depth + 1)
      }
      if (shown.length < entries.length)
        rows.push({ path: prefix + '/…', name: `… ${entries.length - shown.length} more`, depth, kind: 'more', isOpen: false })
    }
    for (const root of this.roots) {
      const isOpen = this.expanded.has(root)
      rows.push({ path: root, name: nameOf(root), depth: 0, kind: 'root', isOpen })
      if (isOpen) walk(root, 1)
    }
    return rows
  }
}
