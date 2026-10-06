# claude-gitlogue

Watch Claude work. A [Claude Code](https://claude.com/claude-code) mod that opens a pane beside the
conversation and replays everything Claude does the way
[gitlogue](https://github.com/unhappychoice/gitlogue) replays a commit: a file tree, an editor
that types each change at a human pace, the turn's details and a terminal. The conversation itself
moves into a phone-style chat on the pane's left.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install gitlogue --marketplace abyss464/claude-gitlogue
```

Answer `y` to add the marketplace, then pick a scope. The pane opens by itself when a session starts
in a terminal 144 columns or wider; `/gitlogue` shows or hides it at any width.

## What it shows

Each of Claude's actions plays as a person at a desk would do it:

| Claude | The pane |
| --- | --- |
| edits or writes a file | walks the file tree (or the Quick Open palette) to the file and types the change; a small change to a line is retyped in place, not deleted and rewritten |
| reads a file | opens it and sweeps a highlighter over the lines read |
| runs `grep`, `rg`, `git grep` and the like | types the query into a search sidebar and lists the matching files and lines |
| runs `fd` or `find` | types the pattern into the Quick Open palette |
| runs a command | types it into the terminal, shows a spinner with the time running, then its output |
| commits or pushes | marks the committed files and shows the commit and the push |
| deletes a file | the file flies from the tree into a trash can |
| searches the web | a search page: the query typed, the results listed |
| fetches a page | a browser: the address typed, the page shown |
| looks at an image | an image viewer shows it (terminals with the kitty graphics protocol) |
| downloads with `curl`, `wget` or `aria2c` | a progress bar |

Logs, lock files and generated files are counted, not typed. Wide characters (Chinese, Japanese,
Korean, emoji) are drawn at their full width.

The phone holds the whole conversation with read receipts and a typing indicator; scroll it with
the mouse wheel. It survives a reload, `/resume` and a compacted conversation.

`/gitlogue replay [session]` plays a recorded session again from its start, at the pace it ran,
without running the model.

When an MCP server named `hypr-screens` is connected and records Claude's own screens, the pane
plays those recordings, sped up, instead of showing their screenshots.

## Options

Set them when installing; each is also a row in `/config`, and a change there applies at once.

| Option | Values | Default |
| --- | --- | --- |
| Theme | gitlogue's 17 themes: `tokyo-night`, `catppuccin`, `dracula`, `nord`, `gruvbox` and more | `tokyo-night` |
| Playback speed | `0.1x` to `10x` | `1x` |
| Max lag | seconds the replay may fall behind before it speeds up | `20` |
| Open the pane | `auto` (when a session starts), `command` (only with `/gitlogue`) | `auto` |
| Chat view | `on` (the phone), `off` (the usual transcript) | `on` |
| Language | `auto`, `en`, `zh`, `ja`; `auto` follows Claude Code's `language` setting, then the system locale | `auto` |

## Requirements

- Claude Code in a terminal, with plugin hooks modules (mods).
- Optional: ImageMagick (`magick`) to show images other than PNG; `ffmpeg` to play screen
  recordings; `jq` to rebuild the chat of a session recorded before this mod kept it.

## Credits

The look, pacing and color themes come from [gitlogue](https://github.com/unhappychoice/gitlogue) by
unhappychoice (ISC License).

## License

ISC. See [LICENSE](LICENSE).
