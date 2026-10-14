/**
 * Text hygiene for the voice loop: turning Markdown into something worth
 * hearing, and cutting a streaming reply into speakable segments.
 *
 * Both halves are pure functions with no DOM or React access, so they are
 * unit-tested directly.
 *
 * @module dsh-voice/client/sanitize
 */

/** Characters that must never survive into speech as their own word. */
const MARKUP = /[*_`~#>|]+/gu

/**
 * Strip Markdown and code so a reply reads as prose.
 *
 * Code blocks are removed entirely (their contents are not meaningful aloud),
 * inline code keeps its text, links keep their label, and tables are dropped
 * whole. Emoji and control characters are removed last.
 *
 * @param text - raw assistant Markdown.
 * @returns speakable plain text.
 */
export function sanitizeSpeech(text) {
  if (typeof text !== 'string' || text === '') return ''
  let value = text
  // ── Content that is never spoken ──────────────────────────────────────────
  // Code and tables are skipped ENTIRELY, with no placeholder. A fenced block
  // read aloud is noise, and a table read row by row ("， 方案 ， 优点 ， 缺点 ，")
  // is worse than useless for anything wider than two columns.
  value = value.replace(/^[ \t]*```[\s\S]*?^[ \t]*```[ \t]*$/gmu, ' ')
  value = value.replace(/^[ \t]*~~~[\s\S]*?^[ \t]*~~~[ \t]*$/gmu, ' ')
  // A fence that was cut off mid-stream still swallows the rest, so a partial
  // code block never leaks identifiers into the reading.
  value = value.replace(/^[ \t]*```[\s\S]*$/gmu, ' ')
  // A table row whose closing pipe has not arrived yet.
  //
  // A streamed row ends inside a cell, so the line does not end with `|` and the
  // closing pipe never comes. The whole-table rule below needs the separator row
  // before it can recognise the table, and while the header and separator are
  // both present this row is left over — that leftover read as ordinary prose,
  // which is where `ENOENT: no such file` was spoken aloud from.
  value = value.replace(/^[ \t]*\|(?:[^\n|]*\|)*[^\n|]+$/gmu, ' ')
  // A whole table: a header row, the `---` separator and every body row.
  value = value.replace(/^[ \t]*\|.*\|[ \t]*\n?[ \t]*\|[ \t:|-]*\|[ \t]*\n?(?:^[ \t]*\|.*\|[ \t]*\n?)*/gmu, ' ')
  // A stray pipe row: one that starts or ends with a pipe and was not part of a
  // table this scan could recognise.
  value = value.replace(/^[ \t]*\|.*$/gmu, ' ')
  // A pipe-delimited row without the outer pipes (`A | B | C`), which GitHub
  // renders as a table just the same. Judged per line, because a regex cannot
  // tell a two-cell row from prose that happens to contain a pipe.
  value = value.split('\n').filter((line) => !looksLikePipeRow(line)).join('\n')
  // An indented code block: four spaces mark one in Markdown, and a model that
  // emits one instead of a fence must not have its identifiers read out.
  value = value.replace(/^[ \t]{4,}\S.*(?:\n[ \t]{4,}\S.*)*/gmu, ' ')
  value = value.replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
  value = value.replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
  value = value.replace(/`([^`]*)`/gu, '$1')
  value = value.replace(/^\s*[-*+]\s+/gmu, '')
  value = value.replace(/^\s*\d+[.)]\s+/gmu, '')
  value = value.replace(/^\s{0,3}#{1,6}\s*/gmu, '')
  value = value.replace(/^\s*>\s?/gmu, '')
  value = value.replace(/^\s*([-*_]\s*){3,}$/gmu, ' ')
  value = value.replace(/<[^>]{1,120}>/gu, ' ')
  value = value.replace(MARKUP, '')
  value = value.replace(/https?:\/\/\S+/gu, ' 链接 ')
  value = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, ' ')
  value = value.replace(/[\u{1f300}-\u{1faff}\u{2600}-\u{27bf}\u{fe0f}\u{1f000}-\u{1f2ff}]/gu, '')
  value = value.replace(/[ \t]{2,}/gu, ' ')
  value = value.replace(/\n{3,}/gu, '\n\n')
  return value.trim()
}

/**
 * Whether one line is a borderless table row rather than prose.
 *
 * A row like `方案 | 优点 | 缺点` has cells that carry no sentence punctuation
 * and at least three pipe-separated parts; a sentence such as
 * `这个符号 | 是竖线，不是表格。` has ordinary punctuation and is kept.
 *
 * @param line - one source line.
 * @returns true when the line should be treated as table content.
 */
function looksLikePipeRow(line) {
  const trimmed = line.trim()
  if (trimmed === '' || !trimmed.includes('|')) return false
  // A line already wrapped in pipes is handled by the block pattern above; if it
  // survives to here it is a stray row and still goes.
  if (trimmed.startsWith('|') || trimmed.endsWith('|')) return true
  // The `--- | :---:` separator of a borderless table.
  if (/^[\s:|-]+$/u.test(trimmed) && trimmed.includes('-')) return true
  const cells = trimmed.split('|').map((cell) => cell.trim())
  // Two columns are enough (`方案 | 优点`), but a single pipe is prose.
  if (cells.length < 2) return false
  if (cells.some((cell) => cell === '')) return false
  // Sentence punctuation inside a cell means this is prose, not a table.
  return !cells.some((cell) => /[。！？；：,.!?;:]/u.test(cell))
}

/**
 * Decide whether a character ends a spoken segment at this position.
 *
 * A `.` only ends a sentence when it is not surrounded by digits (so "3.14"
 * and "v1.2" stay inside one segment) and is followed by a space or the end.
 *
 * @param text - the whole buffer.
 * @param index - the candidate terminator's index.
 * @returns true when a cut is allowed here.
 */
/**
 * Whether a character ends a spoken segment at this position.
 *
 * The terminator set is written out here rather than kept in a Set because `.`
 * needs its surroundings: a period inside a number (`3.5`) or before a word
 * (`example.com`) is not a sentence end, and the other characters are.
 *
 * @param text - the buffer.
 * @param index - the position to judge.
 * @returns true when a segment may end just after this character.
 */
function isCut(text, index) {
  const char = text[index]
  if (char === '\n') return true
  if (char === '。' || char === '！' || char === '？' || char === '；' || char === '…' || char === '!' || char === '?' || char === ';') return true
  if (char !== '.') return false
  const before = text[index - 1] ?? ''
  const after = text[index + 1] ?? ''
  if (/[0-9]/u.test(before) && /[0-9]/u.test(after)) return false
  if (/[A-Za-z0-9]/u.test(after)) return false
  return true
}

/**
 * Cut one streaming buffer into the segments that are ready to speak.
 *
 * The buffer is consumed up to the last usable terminator (or up to
 * `softChunkChars` when a model produces a long unpunctuated run), and the
 * unfinished tail is returned for the next delta. A very long unpunctuated
 * buffer is cut at the last comma or space so the reader starts talking
 * instead of waiting for a full stop that may never come.
 *
 * @param buffer - text accumulated since the last cut.
 * @param softChunkChars - length at which an unpunctuated buffer is split.
 * @param final - true when the turn ended and the whole buffer must be cut.
 * @returns `{ segments, rest }`.
 */
export function cutSegments(buffer, softChunkChars, final) {
  const segments = []
  let rest = buffer
  // The hard ceiling: a clause this long is spoken even with no punctuation.
  const ceiling = Math.max(16, softChunkChars)
  // Once a clause has run this long, the reader starts on the next natural
  // break rather than waiting for a full stop.
  const startAt = Math.max(10, Math.round(ceiling / 3))
  for (;;) {
    if (rest.trim() === '') {
      rest = ''
      break
    }
    const sentence = lastTerminator(rest)
    if (sentence > 0 && rest.slice(0, sentence).trim().length >= 2) {
      segments.push(rest.slice(0, sentence))
      rest = rest.slice(sentence)
      continue
    }
    if (rest.trim().length >= startAt) {
      const natural = lastSoftBreak(rest)
      const at = natural > 0 ? natural : rest.length >= ceiling ? ceiling : -1
      if (at > 0) {
        segments.push(rest.slice(0, at))
        rest = rest.slice(at)
        continue
      }
    }
    if (final && rest.trim() !== '') {
      segments.push(rest)
      rest = ''
    }
    break
  }
  if (final && rest.trim() !== '') segments.push(rest)
  return {
    segments: segments.map((segment) => segment.trim()).filter((segment) => segment !== ''),
    rest: final ? '' : rest,
  }
}

/**
 * The index just past the LAST usable sentence terminator in the buffer, or -1.
 *
 * @param text - the buffer.
 * @returns the cut index, or -1 when nothing ends a sentence.
 */
function lastTerminator(text) {
  let cut = -1
  for (let index = 0; index < text.length; index += 1) {
    if (isCut(text, index)) cut = index + 1
  }
  return cut
}

/**
 * Find the last natural break — a comma, colon, ideographic comma or space —
 * in the last third of the buffer. Used to start the reader on a clause
 * boundary instead of mid-word when no sentence terminator has arrived yet.
 *
 * @param text - the buffer.
 * @returns the cut index just past the break, or -1 when none exists.
 */
function lastSoftBreak(text) {
  const floor = Math.max(6, Math.floor(text.length / 3))
  for (let index = text.length - 1; index >= floor; index -= 1) {
    const char = text[index]
    if (char === '，' || char === ',' || char === '、' || char === '：' || char === ':' || char === ' ') return index + 1
  }
  return -1
}

/**
 * True when a text carries nothing worth speaking (pure punctuation, a code
 * note, or whitespace).
 *
 * @param text - candidate text.
 * @returns true when the text should be skipped.
 */
export function silentText(text) {
  if (typeof text !== 'string') return true
  return text.replace(/[\s\p{P}\p{S}]/gu, '') === ''
}
