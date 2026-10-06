// The words the pane and the phone show, in each language they speak. The
// session picks one as it starts: the mod's own option, else Claude Code's
// language setting, else the system locale, else English.

export type Language = 'en' | 'zh' | 'ja'

const en = {
  waiting: 'Waiting for Claude...',
  waitingEdit: 'Waiting for Claude to edit...',
  screen: (name: string) => `screen ${name}`,
  googleButtons: '[ Google Search ]   [ I’m Feeling Lucky ]',
  searchTitle: 'SEARCH',
  searchResults: (results: number, files: number) => `${results} results in ${files} files`,
  movedToTrash: 'moved to trash',
  moreLines: (lines: number) => `… +${lines} lines`,
  notReplayed: (why: string) => `${why}, not replayed`,
  lockFile: 'lock file',
  logFile: 'log',
  generated: 'generated',
  tooLarge: 'too large',
  webStats: (results: number, seconds: string) => `${results} results (${seconds} seconds)`,
  pushed: (duration: string) => `pushed · ${duration}`,
  openFile: 'Open File...',
  done: 'Done',
  interrupted: 'Interrupted',
  turn: 'turn: ',
  author: 'author: ',
  date: 'date: ',
  changes: 'changes: ',
  noChanges: 'no files changed yet',
  files: (count: number) => `${count} file${count === 1 ? '' : 's'}`,
  noTurn: 'No turn yet',
  terminalOnly: 'gitlogue draws in the terminal.',
  needsRoom: 'gitlogue needs more room.',
  read: 'Read',
  typing: 'typing…',
  backToLatest: '↓ Back to the latest',
  images: (count: number) => `[${count} image${count === 1 ? '' : 's'}]`,
  notStarted: 'gitlogue has not started yet.',
  nothingRecorded: 'No recorded session to replay yet.',
  noReplayLog: (file: string) => `No replay log at ${file}.`,
  replaying: (steps: number, file: string) => `Replaying ${steps} recorded steps from ${file}.`,
  commandDescription: "Show or hide the gitlogue pane, which replays Claude's edits as live typing; `replay [session]` plays a recorded session again from its start",
}

export type Words = typeof en

const zh: Words = {
  waiting: '等待 Claude…',
  waitingEdit: '等待 Claude 修改…',
  screen: name => `屏幕 ${name}`,
  googleButtons: '[ Google 搜索 ]   [ 手气不错 ]',
  searchTitle: '搜索',
  searchResults: (results, files) => `${files} 个文件中有 ${results} 个结果`,
  movedToTrash: '已移到回收站',
  moreLines: lines => `… 还有 ${lines} 行`,
  notReplayed: why => `${why}，不回放`,
  lockFile: '锁文件',
  logFile: '日志',
  generated: '生成的文件',
  tooLarge: '太大',
  webStats: (results, seconds) => `找到约 ${results} 条结果（用时 ${seconds} 秒）`,
  pushed: duration => `已推送 · ${duration}`,
  openFile: '打开文件…',
  done: '完成',
  interrupted: '已中断',
  turn: '轮次：',
  author: '作者：',
  date: '日期：',
  changes: '改动：',
  noChanges: '还没有改动文件',
  files: count => `${count} 个文件`,
  noTurn: '还没有对话',
  terminalOnly: 'gitlogue 只在终端里绘制。',
  needsRoom: 'gitlogue 需要更大的空间。',
  read: '已读',
  typing: '正在输入…',
  backToLatest: '↓ 回到最新',
  images: count => `[${count} 张图片]`,
  notStarted: 'gitlogue 还没有启动。',
  nothingRecorded: '还没有可以回放的会话记录。',
  noReplayLog: file => `${file} 没有回放记录。`,
  replaying: (steps, file) => `正在回放 ${file} 中记录的 ${steps} 步。`,
  commandDescription: '显示或隐藏 gitlogue 面板，它把 Claude 的修改回放成实时打字；`replay [session]` 从头回放一段录下的会话',
}

const ja: Words = {
  waiting: 'Claude を待っています…',
  waitingEdit: 'Claude の編集を待っています…',
  screen: name => `画面 ${name}`,
  googleButtons: '[ Google 検索 ]   [ I’m Feeling Lucky ]',
  searchTitle: '検索',
  searchResults: (results, files) => `${files} ファイルに ${results} 件の結果`,
  movedToTrash: 'ゴミ箱に移動しました',
  moreLines: lines => `… 他 ${lines} 行`,
  notReplayed: why => `${why}のため再生しません`,
  lockFile: 'ロックファイル',
  logFile: 'ログ',
  generated: '生成ファイル',
  tooLarge: '大きすぎる',
  webStats: (results, seconds) => `約 ${results} 件（${seconds} 秒）`,
  pushed: duration => `プッシュ済み · ${duration}`,
  openFile: 'ファイルを開く…',
  done: '完了',
  interrupted: '中断しました',
  turn: 'ターン: ',
  author: '作者: ',
  date: '日付: ',
  changes: '変更: ',
  noChanges: 'まだ変更はありません',
  files: count => `${count} ファイル`,
  noTurn: 'まだターンはありません',
  terminalOnly: 'gitlogue はターミナルでのみ表示されます。',
  needsRoom: 'gitlogue を表示するには幅が足りません。',
  read: '既読',
  typing: '入力中…',
  backToLatest: '↓ 最新に戻る',
  images: count => `[画像 ${count} 枚]`,
  notStarted: 'gitlogue はまだ起動していません。',
  nothingRecorded: '再生できる記録はまだありません。',
  noReplayLog: file => `${file} に再生記録がありません。`,
  replaying: (steps, file) => `${file} に記録された ${steps} ステップを再生します。`,
  commandDescription: 'gitlogue パネルの表示を切り替えます。Claude の編集をライブのタイピングとして再生します。`replay [session]` で記録したセッションを最初から再生します',
}

const TABLES: Record<Language, Words> = { en, zh, ja }

// The words in use, changed in place so every module reads the current ones.
export const words: Words = { ...en }

export function speak(language: Language) {
  Object.assign(words, TABLES[language])
}

// The language a name means: an option's value, a setting such as "Chinese",
// or a locale such as "zh_CN.UTF-8".
export function languageOf(name: string | undefined): Language | undefined {
  const text = (name ?? '').trim().toLowerCase()
  if (/^zh|chinese|mandarin|cantonese|中文|汉语|漢語|简体|繁體/.test(text)) return 'zh'
  if (/^ja|japanese|日本/.test(text)) return 'ja'
  if (/^en|english/.test(text)) return 'en'
  return undefined
}
