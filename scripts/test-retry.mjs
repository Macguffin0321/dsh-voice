#!/usr/bin/env node
/**
 * Playback and synthesis resilience tests.
 *
 * These run against the REAL bundle with a stubbed page, because the failures
 * they pin can only be injected at that level: the bundle captures its own
 * `fetch` and its own audio element, so a test that swaps a global around it
 * intercepts nothing.
 *
 * Three failures are covered, all of which a listener hears as "the reading
 * stopped" and none of which can be told apart from a finished reply:
 *
 *  1. a synthesis request that fails once drops its whole segment;
 *  2. text that arrives after the queue drained is stepped over by the resume;
 *  3. an `ended` event that arrives long before the end of the audio is treated
 *     as the end of the sentence.
 *
 * Run with `node scripts/test-retry.mjs`.
 *
 * @module dsh-voice/scripts/test-retry
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const failures = []
/** Assert one condition. */
function check(condition, label, detail = '') {
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
  process.stdout.write(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
}

/** A media element that finishes instantly: this test is about the queue. */
class FakeAudio {
  /** Duration the host declared, which the element then reports. */
  static declared = 8

  /** When true, the first play of a segment stops a fifth of the way in. */
  static stopEarlyOnce = false

  constructor() {
    this.src = ''
    this.currentTime = 0
    this.duration = 0
    this.paused = true
    this.plays = 0
    this.listeners = new Map()
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  removeEventListener() {}

  emit(type) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type })
  }

  async play() {
    this.paused = false
    this.plays += 1
    // Element metadata arrives from the file, as a browser would report it.
    if (this.duration === 0) this.duration = FakeAudio.declared
    const stopsAt = FakeAudio.stopEarlyOnce && this.plays === 1
      ? FakeAudio.declared * 0.2
      : FakeAudio.declared
    pendingSegments.push(() => {
      this.currentTime = stopsAt
      this.emit('ended')
    })
  }

  pause() {}

  load() {}

  removeAttribute() { this.src = '' }
}

const react = {
  createElement: () => ({}),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect() {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

/**
 * Segments that end only when the test says so.
 *
 * The drain race needs the queue to be empty at a chosen instant, which an
 * instantly-finishing element can never provide: it always leaves the playhead
 * one segment short of the end, so the resume path under test is never reached.
 */
const pendingSegments = []

globalThis.Audio = FakeAudio
globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} }
globalThis.localStorage = { getItem: () => null, setItem() {} }
globalThis.document = {
  createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, remove() {}, appendChild() {}, addEventListener() {}, removeAttribute() {}, load() {} }),
  head: { appendChild() {} },
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
}

const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
let definition = null
const window = {
  __ModuleLoader__: { load: (entry) => { definition = entry } },
  location: { protocol: 'http:', host: 'x' },
  localStorage: globalThis.localStorage,
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1200,
  innerHeight: 800,
}
globalThis.window = window
new Function('window', src)(window)

const exportsValue = definition.factory((specifier) => (specifier === 'react' ? react : {}))

/** Requests this test made, in order. */
const segmentRequests = []
/** Segment texts whose first attempt is failed. */
const injected = new Set()
let attemptsForLast = 0

globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  if (target.includes('/voice/segment')) {
    const body = JSON.parse(options.body ?? '{}')
    segmentRequests.push(body.text)
    if (body.text.includes('结尾这一句')) {
      attemptsForLast += 1
      if (!injected.has(body.text)) {
        injected.add(body.text)
        return {
          ok: false,
          status: 503,
          headers: { get: () => null },
          json: async () => ({ ok: false, error: '暂时不可用' }),
          text: async () => '{"error":"暂时不可用"}',
          blob: async () => ({ size: 0 }),
        }
      }
    }
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name) => ({
          'x-voice-duration': String(FakeAudio.declared),
          'x-voice-engine': 'edge',
          'x-voice-voice': 'v',
        })[String(name).toLowerCase()] ?? null,
      },
      json: async () => ({}),
      text: async () => '',
      blob: async () => ({ size: 100 }),
    }
  }
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      ok: true,
      engine: 'auto',
      resolved: 'edge',
      autoRead: true,
      softChunkChars: 40,
      maxCharsPerRequest: 2000,
      voices: [],
      frames: [],
      cursor: 0,
    }),
    text: async () => '',
    blob: async () => ({ size: 1 }),
  }
}

exportsValue.apply({
  slots: { inject: (name, factory) => factory(), register: () => () => {} },
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  get: () => undefined,
  logger: { info() {}, warn() {} },
})

process.stdout.write('dsh-voice synthesis-retry tests\n')

const live = globalThis.__DSH_VOICE__
const heard = []
const player = live.reader
const originalPlay = player.audio.play.bind(player.audio)
player.audio.play = async function play() {
  const segment = player.segments[player.cursor]
  if (segment !== undefined) heard.push(segment.text)
  return originalPlay()
}

const sessionId = 'retry-session'
live.voice.setCurrentSession(sessionId)
const reply = '第一段正文内容。\n\n第二段正文内容。\n\n结尾这一句必须被念到。\n'
live.bridge.onFrame(sessionId, JSON.stringify({ type: 'start', sessionId, attemptId: 'retry', turn: 1 }))
for (let index = 0; index < reply.length; index += 15) {
  live.bridge.onFrame(sessionId, JSON.stringify({ type: 'delta', sessionId, text: reply.slice(index, index + 15) }))
}
live.bridge.onFrame(sessionId, JSON.stringify({ type: 'end', sessionId }))

// The first retry waits 400ms; leave room for two attempts plus synthesis, and
// drive the playback by hand so every queued segment actually plays through.
for (let round = 0; round < 60; round += 1) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 80))
  const audio = live.reader.audio
  if (audio === null || audio.paused) continue
  audio.currentTime = FakeAudio.declared
  audio.emit('ended')
}

check(injected.size === 1, 'the final segment was made to fail once', String(injected.size))
check(attemptsForLast >= 2, 'the failed segment was retried', String(attemptsForLast))
check(
  heard.some((text) => text.includes('结尾这一句')),
  'the retried segment is still spoken',
  JSON.stringify(heard.slice(-1)),
)
check(
  player.segments.every((segment) => segment.state !== 'error'),
  'no segment was left in the error state',
  player.segments.map((segment) => segment.state).join(','),
)
check(
  segmentRequests.filter((text) => text.includes('结尾这一句')).length >= 2,
  'the same text was requested again after the failure',
  String(segmentRequests.length),
)

// ── text arriving after the queue drained must still be read ───────────────
// The bug this pins: when the last queued segment finished, the playhead was
// parked at `segments.length`. The tail that arrived afterwards was queued at
// exactly that index, and the resume then started from `cursor + 1` — one past
// it. Playback stalled reporting "buffering" while claiming to play, which a
// listener hears as the reply stopping mid-sentence.
//
// The assertion is on the INDEX that played. A text-level check passes against
// the broken resume too — the segment is loaded either way — and proves nothing.
{
  const player = live.reader
  /** Segment indices the player actually started on. */
  const started = []
  const originalPlay = player.audio.play.bind(player.audio)
  player.audio.play = async function play() {
    if (player.cursor >= 0) started.push(player.cursor)
    return originalPlay()
  }

  const sessionId = 'drain-session'
  live.voice.setCurrentSession(sessionId)
  live.bridge.onFrame(sessionId, JSON.stringify({ type: 'start', sessionId, attemptId: 'drain', turn: 1 }))
  live.bridge.onFrame(sessionId, JSON.stringify({ type: 'delta', sessionId, text: '第一段会被读完。\n\n' }))
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
  check(started.includes(0), 'the first segment starts playing', JSON.stringify(started))

  // finish it at its full duration: the queue drains and playback stops
  player.audio.currentTime = FakeAudio.declared
  player.audio.emit('ended')
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
  check(player.playing === false, 'the queue drained and playback stopped', `${String(player.playing)} cursor=${String(player.cursor)}`)
  check(
    player.cursor === player.segments.length,
    'the playhead is parked at the end of the queue',
    `cursor=${String(player.cursor)} segments=${String(player.segments.length)}`,
  )

  // the tail now arrives at exactly the index the playhead is parked on
  live.bridge.onFrame(sessionId, JSON.stringify({ type: 'delta', sessionId, text: '结尾这一句必须被念到。\n' }))
  live.bridge.onFrame(sessionId, JSON.stringify({ type: 'end', sessionId }))
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  player.audio.play = originalPlay

  check(player.segments.length === 2, 'the tail was queued after the drain', String(player.segments.length))
  check(started.includes(1), 'the queued tail segment is played, not stepped over', JSON.stringify(started))
  check(player.phase !== 'buffering', 'the reader is not left reporting buffering', String(player.phase))
}

// ── an early `ended` must not cut a sentence short ─────────────────────────
// An `ended` event also fires when the element stops long before the end of the
// audio it was given — a stalled or partially decoded stream, for example.
// Treated as a normal end, that is heard as the reading stopping mid-sentence,
// which is indistinguishable from the reply having ended.
//
// Each case below drives ONE segment, because a single segment is all the
// question needs: the detector sees the media position and the declared
// duration, and nothing else about the reading matters.
{
  /**
   * Stream one segment and end it at a chosen media position.
   *
   * @param label - the session label.
   * @param atFraction - where the `ended` event reports the playhead stopped.
   * @returns the segment after the reader reacted.
   */
  const endOneSegmentAt = async (label, atFraction) => {
    live.reader.reset()
    live.reader.segments.length = 0
    FakeAudio.declared = 8
    const sessionId = `ended-${label}`
    live.voice.setCurrentSession(sessionId)
    live.bridge.onFrame(sessionId, JSON.stringify({ type: 'start', sessionId, attemptId: label, turn: 1 }))
    live.bridge.onFrame(sessionId, JSON.stringify({ type: 'delta', sessionId, text: `第${label}句正文内容。\n\n` }))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
    const audio = live.reader.audio
    audio.currentTime = FakeAudio.declared * atFraction
    audio.emit('ended')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
    return live.reader.segments[0]
  }

  const playedThrough = await endOneSegmentAt('跑完', 1)
  check(
    (playedThrough.replays ?? 0) === 0,
    'a segment that plays through is never replayed',
    `replays=${String(playedThrough.replays ?? 0)} state=${playedThrough.state}`,
  )
  check(playedThrough.state === 'done', 'a completed segment is marked done', playedThrough.state)

  const cutShort = await endOneSegmentAt('截断', 0.2)
  check(
    (cutShort.replays ?? 0) > 0,
    'a segment whose `ended` arrives early is replayed',
    `replays=${String(cutShort.replays ?? 0)} state=${cutShort.state}`,
  )
  check(cutShort.state !== 'done', 'an early `ended` does not mark the segment finished', cutShort.state)
}

// ── a stale audio element must not trigger a replay ────────────────────────
// The reported log showed two replays 29 minutes after the reading had stopped:
// the user had resumed playback, the element was carrying a DIFFERENT segment's
// audio, and its `currentTime` was compared against this segment's declared
// duration. A position is only meaningful for the audio it belongs to.
{
  live.reader.reset()
  live.reader.segments.length = 0
  FakeAudio.declared = 16
  const sessionId = 'stale-session'
  live.voice.setCurrentSession(sessionId)
  live.bridge.onFrame(sessionId, JSON.stringify({ type: 'start', sessionId, attemptId: 'stale', turn: 1 }))
  live.bridge.onFrame(sessionId, JSON.stringify({ type: 'delta', sessionId, text: '这一句会播完。\n\n' }))
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  const audio = live.reader.audio
  const segment = live.reader.segments[0]
  check(segment.duration === 16, 'the declared duration reached the segment', String(segment.duration))

  // The element is now carrying someone else's audio, stopped near its start.
  audio.src = 'blob:someone-else'
  audio.currentTime = 3.1
  audio.emit('ended')
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 120))
  check(
    (segment.replays ?? 0) === 0,
    'no replay is triggered while the element carries another segment',
    `replays=${String(segment.replays ?? 0)} src=${audio.src}`,
  )

  // The stale `ended` was taken as a normal end, so the playhead moved on. Put
  // it back on the same segment to ask the second question, about the same
  // audio that now really did stop early.
  live.reader.cursor = 0
  segment.state = 'ready'
  segment.replays = 0
  audio.src = segment.url
  audio.currentTime = 3.1
  audio.emit('ended')
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 120))
  check(
    (segment.replays ?? 0) > 0,
    'a genuine early end on the right audio still replays',
    `replays=${String(segment.replays ?? 0)} src=${audio.src} ct=${String(audio.currentTime)}`,
  )
}

// ── one segment must be requested exactly once ─────────────────────────────
// The prefetch pump and the playback advance both call `#load`, and the guard
// against a second request is `segment.promise`. That cell used to be claimed
// inside the async body AND released in that body's `finally`, so there was a
// window where the guard was empty and the same segment was requested again —
// four requests for one segment were observed in a real session, each one
// restarting the audio element and aborting the play in flight.
{
  live.reader.reset()
  live.reader.segments.length = 0
  const sessionId = 'dedupe-session'
  live.voice.setCurrentSession(sessionId)
  const requested = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    if (target.includes('/voice/segment')) {
      const body = JSON.parse(options.body ?? '{}')
      requested.push(body.text)
      // a real synthesis takes time; the race lives inside that window
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 30))
    }
    return originalFetch(url, options)
  }
  const reply = '第一段正文内容，需要念出来。\n\n第二段正文内容，也需要念。\n\n'
  live.bridge.onFrame(sessionId, JSON.stringify({ type: 'start', sessionId, attemptId: 'dedupe', turn: 1 }))
  for (let index = 0; index < reply.length; index += 18) {
    live.bridge.onFrame(sessionId, JSON.stringify({ type: 'delta', sessionId, text: reply.slice(index, index + 18) }))
  }
  live.bridge.onFrame(sessionId, JSON.stringify({ type: 'end', sessionId }))
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 600))
  globalThis.fetch = originalFetch

  const counts = new Map()
  for (const text of requested) counts.set(text, (counts.get(text) ?? 0) + 1)
  const repeated = [...counts.entries()].filter(([, count]) => count > 1)
  check(repeated.length === 0, 'each segment is synthesised exactly once', JSON.stringify(repeated))
  check(counts.size > 0, 'the dedupe scenario actually requested something', String(counts.size))
}

process.stdout.write(failures.length === 0 ? '\nPASS\n' : `\nFAILED (${String(failures.length)})\n${failures.join('\n')}\n`)
process.exit(failures.length === 0 ? 0 : 1)
