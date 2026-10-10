import { cutSegments } from './sanitize.js'

/**
 * The reading engine: a queue of spoken segments with a transport.
 *
 * Segments arrive while the reply is still streaming, so the engine is built
 * around three separate concerns that must not block one another:
 *
 * 1. **Synthesis** — `enqueue()` accepts text immediately and resolves each
 *    segment's audio through `/voice/segment` with limited concurrency, so a
 *    long reply keeps the reader fed without flooding the host.
 * 2. **Playback** — one `<audio>` element plays one segment at a time and
 *    advances on `ended`. Because the element owns the media clock, pause,
 *    resume and seek are exact rather than approximated.
 * 3. **Transport** — the timeline is the ordered segment list plus each
 *    segment's duration; ±30 s seek walks that timeline, and a seek into a
 *    segment that is not ready yet simply waits for it (the status reports
 *    `buffering`).
 *
 * The engine never throws at the UI: a failed segment is marked `error`,
 * reported through `onError`, and skipped so one bad synthesis cannot stop a
 * whole reply.
 *
 * @module dsh-voice/client/speak
 */

/** How many segments may synthesize at once. */
const SYNTH_CONCURRENCY = 2

/** How many segments ahead of the playhead keep their audio warm. */
const PREFETCH_AHEAD = 4

/** How many synthesis round trips the diagnostic trail retains. */
const REQUEST_TRAIL = 12

/** How many diagnostic log lines are retained. */
const LOG_TRAIL = 60

/**
 * Attempts per segment before it is given up on.
 *
 * A single transient failure used to drop the segment for good, which is heard
 * as the reading stopping mid-turn — the most damaging failure this plugin can
 * have, because the listener cannot tell it apart from the reply having ended.
 */
const SYNTH_ATTEMPTS = 3

/** Base delay between attempts, in milliseconds (doubled each time). */
const SYNTH_RETRY_MS = 400

/** How many times one segment may be replayed after an early `ended`. */
const REPLAY_ATTEMPTS = 2

/**
 * One shared diagnostic log for the whole audio pipeline.
 *
 * The failures that matter here are invisible: a request that never leaves, a
 * response that never arrives and a player that refuses to start all look like
 * "no sound". Every step therefore writes a line, and
 * {@link VoiceBridge.diagnose} can hand the whole trail to the user, who has no
 * developer console in the desktop client.
 */
class VoiceLog {
  constructor() {
    /** @type {string[]} */
    this.lines = []
  }

  /**
   * Append one line.
   *
   * @param step - short stage name (`fetch`, `media`, `voice`, …).
   * @param detail - what happened.
   */
  add(step, detail) {
    const at = new Date().toISOString().slice(11, 23)
    this.lines.push(`${at} [${step}] ${detail}`)
    if (this.lines.length > LOG_TRAIL) this.lines.splice(0, this.lines.length - LOG_TRAIL)
  }

  /** The retained lines. */
  text() {
    return this.lines.join('\n')
  }
}

/** The process-wide diagnostic log. */
export const voiceLog = new VoiceLog()

/** One spoken segment's lifecycle. */
export const SEGMENT = {
  /** Text accepted, no audio requested yet. */
  PENDING: 'pending',
  /** Audio requested. */
  LOADING: 'loading',
  /** Audio ready to play. */
  READY: 'ready',
  /** Played to its end. */
  DONE: 'done',
  /** Synthesis failed; will be skipped. */
  ERROR: 'error',
}

let nextSegmentId = 0

/**
 * A short content fingerprint of one audio blob.
 *
 * Comparing a host-returned md5 is not available in the page, so this hashes a
 * sample of the bytes: it is not cryptographic, it only has to differ whenever
 * the audio differs.
 *
 * @param blob - the fetched audio.
 * @returns a short hex fingerprint, or '' when the bytes cannot be read.
 */
async function fingerprintOf(blob) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let hash = 2166136261
    const step = Math.max(1, Math.floor(bytes.length / 2048))
    for (let index = 0; index < bytes.length; index += step) {
      hash ^= bytes[index]
      hash = Math.imul(hash, 16777619)
    }
    return `${(hash >>> 0).toString(16).padStart(8, '0')}:${String(bytes.length)}`
  } catch {
    return ''
  }
}

/**
 * Cut one text into the segments a reading is built from.
 *
 * @param text - the text to cut.
 * @param softChunkChars - the unpunctuated clause limit.
 * @returns the segment texts.
 */
function segmentsOf(text, softChunkChars, maxChars = 800) {
  const out = []
  // First by clause, then by the hard ceiling: an unpunctuated 3000-character
  // reply still has to arrive as several acceptable requests.
  for (const piece of cutSegments(text, softChunkChars, true).segments) {
    for (const chunk of hardSplit(piece, maxChars)) {
      const clean = chunk.trim()
      if (clean !== '') out.push(clean)
    }
  }
  return out
}

/**
 * Split one text into pieces of at most `limit` characters.
 *
 * The cut prefers a sentence end, then any punctuation, then a space, and only
 * falls back to a raw character cut for a single unbroken run.
 *
 * @param text - the text to split.
 * @param limit - the maximum length of one piece.
 * @returns the pieces, in order.
 */
function hardSplit(text, limit) {
  const clean = text.trim()
  if (clean === '' ) return []
  if (clean.length <= limit) return [clean]
  const out = []
  let rest = clean
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let at = -1
    for (const mark of ['。', '！', '？', '；', '.', '!', '?', ';', '\n', '，', ',', '、', '：', ':', ' ']) {
      const found = window.lastIndexOf(mark)
      if (found > at) at = found
    }
    if (at < Math.floor(limit / 3)) at = limit - 1
    out.push(rest.slice(0, at + 1))
    rest = rest.slice(at + 1)
  }
  if (rest.trim() !== '') out.push(rest)
  return out
}

/**
 * Estimate how long a text takes to speak in the page's own voice.
 *
 * Web Speech reports no duration, so the console needs a plausible one: CJK
 * characters count as one unit, Latin words as roughly five characters.
 *
 * @param text - the segment text.
 * @param rate - the configured rate (absolute, 1 = normal).
 * @returns seconds.
 */
function estimateSpeechSeconds(text, rate) {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) ?? []).length
  const rest = text.length - cjk
  const units = cjk + rest / 5
  const speed = Number.isFinite(rate) && rate > 0 ? rate : 1
  return Math.max(0.4, (units * 0.32) / speed)
}

/**
 * The reading engine. One instance serves the whole page; sessions are told
 * apart by the `sessionId` stamped on every segment.
 */
export class Reader {
  /**
   * @param options - `{ baseUrl, onUpdate, onError, getSettings }`.
   */
  constructor(options) {
    this.baseUrl = options.baseUrl ?? ''
    this.onUpdate = options.onUpdate ?? (() => {})
    this.onError = options.onError ?? (() => {})
    this.getSettings = options.getSettings ?? (() => ({}))
    /** Length at which an unpunctuated clause is split (mirrors the bridge). */
    this.softChunkChars = options.softChunkChars ?? 40
    /** The host's per-request character ceiling (mirrors `maxCharsPerRequest`). */
    this.maxCharsPerRequest = options.maxCharsPerRequest ?? 800

    /** @type {Array<object>} every segment ever accepted, in reading order. */
    this.segments = []
    /** Monotonic generation: a newer `start()` abandons older in-flight work. */
    this.generation = 0
    /** Index of the segment that owns the audio element, or -1. */
    this.cursor = -1
    /** True while the transport is playing. */
    this.playing = false
    /** True when the queue ran out and no more text is expected. */
    this.finished = false
    /** Free-text status for the console (`idle` | `playing` | `paused` | `buffering`). */
    this.phase = 'idle'
    /** The voice overrides the next synthesis uses. */
    this.voiceOverride = null
    /** Playback speed multiplier (1 = natural pace). */
    this.rateMultiplier = 1
    /**
     * Highest segment index the reading has finished (played or skipped).
     *
     * The cursor cannot serve this purpose: it is parked at `segments.length`
     * once the queue drains, while more text is still streaming in.
     */
    this.settledThrough = -1
    /** The last text handed to {@link playText}, for one-press re-reading. */
    this.replayText = ''
    /** The engine override the next synthesis uses. */
    this.engineOverride = null

    this.activeLoads = 0
    /** @type {Map<number, boolean>} */
    this.wanted = new Map()
    /** Recent synthesis round trips (bounded); see {@link snapshot}. */
    this.requests = []

    const AudioCtor = globalThis.Audio
    this.audio = typeof AudioCtor === 'function' ? new AudioCtor() : null
    if (this.audio !== null) {
      this.audio.preload = 'auto'
      this.audio.addEventListener('ended', () => { this.#onEnded() })
      this.audio.addEventListener('error', () => { this.#onAudioError() })
      this.audio.addEventListener('play', () => { this.#setPhase('playing') })
      this.audio.addEventListener('pause', () => {
        if (!this.finished && this.audio !== null && !this.audio.ended) this.#setPhase('paused')
      })
    }
  }

  /** Epoch ms of the last traced segment start (diagnostics only). */
  #lastStart

  /** How many segments carry text (the visible queue length). */
  get size() {
    return this.segments.length
  }

  /** The segment index the playhead is inside, or -1. */
  get currentIndex() {
    if (this.cursor >= 0 && this.cursor < this.segments.length) return this.cursor
    return this.segments.length === 0 ? -1 : 0
  }

  /** The segment the playhead is inside. */
  get current() {
    const index = this.currentIndex
    return index < 0 ? undefined : this.segments[index]
  }

  /**
   * Seconds of the reading spent inside the current segment.
   *
   * The media clock runs at `playbackRate`, so media seconds are divided by the
   * speed to keep the timeline in listening time.
   */
  get currentOffset() {
    const audio = this.audio
    if (audio === null || this.cursor < 0) return 0
    const at = Number.isFinite(audio.currentTime) ? audio.currentTime : 0
    const speed = this.rateMultiplier > 0 ? this.rateMultiplier : 1
    return at / speed
  }

  /** Seconds of listening before the current segment. */
  get elapsedBefore() {
    let total = 0
    for (let index = 0; index < this.currentIndex; index += 1) total += this.segmentSeconds(this.segments[index])
    return total
  }

  /**
   * One segment's length in listening seconds.
   *
   * @param segment - the segment, or undefined.
   * @returns seconds at the current speed.
   */
  segmentSeconds(segment) {
    if (segment === undefined) return 0
    const speed = this.rateMultiplier > 0 ? this.rateMultiplier : 1
    return (segment.duration ?? 0) / speed
  }

  /** Total listening seconds produced so far (grows while streaming). */
  get duration() {
    let total = 0
    for (const segment of this.segments) total += this.segmentSeconds(segment)
    return total
  }

  /** Seconds from the start of the reading to the playhead. */
  get position() {
    return this.elapsedBefore + this.currentOffset
  }

  /** The whole text accepted so far. */
  get text() {
    return this.segments.map((segment) => segment.text).join('')
  }

  /**
   * Accept more text for the current reading.
   *
   * @param texts - sanitized segments, in order.
   * @param meta - `{ sessionId, turn, reason }` stamped onto every segment.
   * @returns the created segments.
   */
  enqueue(texts, meta = {}) {
    const created = []
    for (const text of texts) {
      if (typeof text !== 'string' || text.trim() === '') continue
      const segment = {
        id: `v${(nextSegmentId += 1)}`,
        text,
        sessionId: meta.sessionId ?? '',
        turn: meta.turn ?? null,
        reason: meta.reason ?? 'live',
        state: SEGMENT.PENDING,
        notice: '',
        fingerprint: '',
        duration: 0,
        url: null,
        replays: 0,
        error: null,
        voice: '',
        engine: '',
        cached: false,
        promise: null,
      }
      this.segments.push(segment)
      created.push(segment)
    }
    if (created.length > 0) {
      this.finished = false
      this.#pump()
      this.#emit()
    }
    return created
  }

  /**
   * Start a fresh reading, abandoning anything not yet spoken.
   *
   * @param options - `{ keepVoice }`; the voice override survives by default.
   * @returns nothing.
   */
  reset() {
    this.generation += 1
    this.#stopAudio()
    for (const segment of this.segments) this.#release(segment)
    this.segments = []
    this.cursor = -1
    this.settledThrough = -1
    this.playing = false
    this.finished = false
    this.activeLoads = 0
    this.wanted.clear()
    this.#setPhase('idle')
    this.#emit()
  }

  /** Mark that no further text will arrive for this reading. */
  end() {
    this.finished = true
    this.#emit()
  }

  /** Start (or resume) playback. */
  async play() {
    if (this.playing) return
    this.finished = false
    const audio = this.audio
    // Resume the segment the playhead is parked inside, when it was paused
    // part-way through it.
    const current = this.cursor >= 0 && this.cursor < this.segments.length ? this.segments[this.cursor] : undefined
    if (audio !== null && current !== undefined && current.state === SEGMENT.READY && audio.src !== '' && !audio.ended) {
      this.playing = true
      try {
        audio.playbackRate = this.rateMultiplier > 0 ? this.rateMultiplier : 1
        audio.preservesPitch = true
        await audio.play()
      } catch (error) {
        this.playing = false
        this.#report(error)
      }
      this.#emit()
      return
    }
    this.playing = true
    this.#setPhase('buffering')
    await this.#advance(this.#resumeIndex())
    this.#emit()
  }

  /**
   * Whether an `ended` event arrived long before the audio should have finished.
   *
   * The ratio is computed in media seconds, so the playback multiplier cancels
   * out: at 2x both the declared duration and the elapsed media time scale
   * together. A generous threshold is deliberate — a browser may report a
   * slightly short `currentTime` at the end, and replaying a sentence the
   * listener already heard is worse than trusting a near-complete one.
   *
   * @param segment - the segment that just ended.
   * @returns true when it plainly did not play through.
   */
  #endedTooEarly(segment) {
    const audio = this.audio
    if (audio === null || segment.pageSpoken === true) return false
    // The declared duration is authoritative here. The element's own duration is
    // NOT used as the reference: until metadata arrives it is 0, and a ratio
    // against 0 would flag every segment as unfinished and replay the reading
    // endlessly.
    // The element must still be carrying this segment. After a pause and a
    // resume, or while another segment is being loaded, `currentTime` belongs to
    // a different piece of audio — comparing it against this segment's declared
    // duration is meaningless and replays a segment that never played.
    if (segment.url !== null && audio.src !== segment.url) return false
    const declared = segment.duration
    if (!Number.isFinite(declared) || declared <= 1) return false
    const played = Number.isFinite(audio.currentTime) ? audio.currentTime : declared
    // A media element that never learned its own duration cannot be measured, so
    // an implausible element duration means "assume it played".
    const elementDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : declared
    if (Math.abs(elementDuration - declared) > declared) return false
    return played < declared * 0.5
  }

  /**
   * Play the current segment again from its start.
   *
   * @param segment - the segment to replay.
   */
  async #replay(segment) {
    const audio = this.audio
    if (audio === null || segment.url === null) return
    try {
      // Force the element to re-read the audio. An element that stopped after a
      // few seconds of a long file is usually holding a bad or incomplete decode
      // of it, and merely seeking back to zero would replay two seconds of the
      // same bad data.
      if (typeof audio.load === 'function') {
        audio.src = segment.url
        audio.load()
      }
      audio.currentTime = 0
      audio.playbackRate = this.rateMultiplier > 0 ? this.rateMultiplier : 1
      audio.preservesPitch = true
      this.playing = true
      await audio.play()
    } catch (error) {
      // A refused replay is not worth failing the turn over: move on.
      this.#report(error)
      segment.state = SEGMENT.DONE
      this.settledThrough = Math.max(this.settledThrough, this.cursor)
      void this.#advance()
    }
  }

  /**
   * Where playback should resume.
   *
   * After the queue drains, the cursor is parked at `segments.length`. Text can
   * still arrive afterwards (a turn streams for as long as the model talks), so
   * the playhead has to come back to the first segment that has not been played:
   * resuming at `cursor + 1` would step over the segment that just arrived and
   * the reading would stall while reporting that it is playing.
   *
   * @returns the index to start from.
   */
  #resumeIndex() {
    // A segment the playhead is parked inside is resumed from its own start.
    if (this.cursor >= 0 && this.cursor < this.segments.length) return this.cursor
    // The queue drained, so the cursor sits at the end. Resume at the first
    // segment that has not been played — NOT at `cursor + 1`, which is past the
    // text that arrived after the drain.
    for (let index = this.settledThrough + 1; index < this.segments.length; index += 1) {
      const state = this.segments[index].state
      if (state !== SEGMENT.DONE && state !== SEGMENT.ERROR) return index
    }
    return this.segments.length
  }

  /** Pause playback, keeping the playhead inside the current segment. */
  pause() {
    this.playing = false
    const audio = this.audio
    if (audio !== null && !audio.paused) audio.pause()
    globalThis.speechSynthesis?.cancel?.()
    this.#setPhase('paused')
    this.#emit()
  }

  /** Toggle pause / play; a finished reading starts over from the top. */
  async toggle() {
    if (this.playing) {
      this.pause()
      return
    }
    if (this.segments.length > 0 && this.#atEnd()) {
      await this.replay()
      return
    }
    await this.play()
  }

  /** Replay everything from the beginning using the audio already produced. */
  async replay() {
    if (this.segments.length === 0) return
    this.#stopAudio()
    for (const segment of this.segments) {
      if (segment.state === SEGMENT.DONE) segment.state = SEGMENT.READY
    }
    this.cursor = -1
    this.finished = false
    this.playing = false
    await this.play()
  }

  /** True when the playhead sits at (or past) the end of the produced audio. */
  #atEnd() {
    if (this.cursor >= this.segments.length) return true
    const audio = this.audio
    if (audio !== null && audio.ended) return true
    for (let index = Math.max(0, this.cursor); index < this.segments.length; index += 1) {
      const state = this.segments[index].state
      if (state !== SEGMENT.DONE && state !== SEGMENT.ERROR) return false
    }
    return true
  }

  /**
   * Move the playhead by `deltaSeconds` (±30 s from the console).
   *
   * @param deltaSeconds - signed seconds.
   * @returns the resulting phase.
   */
  async seekBy(deltaSeconds) {
    return this.seekTo(this.position + deltaSeconds)
  }

  /**
   * Move the playhead to an absolute timeline position.
   *
   * A target inside a ready segment seeks the media element; a target inside a
   * segment whose audio is still loading waits for it; a target past the last
   * produced segment stops at the live edge and keeps playing when new text
   * arrives.
   *
   * @param seconds - absolute seconds from the start of the reading.
   * @returns the resulting phase.
   */
  async seekTo(seconds) {
    if (this.segments.length === 0) return this.phase
    const target = Math.max(0, seconds)
    let offset = 0
    let index = -1
    for (let candidate = 0; candidate < this.segments.length; candidate += 1) {
      const duration = this.segmentSeconds(this.segments[candidate])
      if (duration <= 0) {
        // An unmeasured segment: treat the target as landing at its start.
        if (target <= offset) {
          index = candidate
          break
        }
        continue
      }
      if (target < offset + duration) {
        index = candidate
        break
      }
      offset += duration
    }
    const wasPlaying = this.playing
    this.#stopAudio()
    if (index < 0) {
      // Past the produced audio: park at the live edge and keep reading.
      this.cursor = this.segments.length
      this.playing = wasPlaying
      if (wasPlaying) {
        this.#setPhase('buffering')
        this.#emit()
        this.#pump()
      } else {
        this.#setPhase('paused')
        this.#emit()
      }
      return this.phase
    }
    const within = Math.max(0, target - offset)
    this.cursor = index
    const segment = this.segments[index]
    this.#setPhase('buffering')
    this.#emit()
    await this.#load(index)
    if (segment.state !== SEGMENT.READY) {
      // Not playable: fall forward to the next ready segment.
      this.playing = wasPlaying
      await this.#advance()
      this.#emit()
      return this.phase
    }
    const audio = this.audio
    if (audio !== null) {
      try {
        // `within` is listening seconds; the media clock runs faster by the
        // multiplier, so the media position is the product.
        const speed = this.rateMultiplier > 0 ? this.rateMultiplier : 1
        audio.playbackRate = speed
        audio.currentTime = Math.min(within * speed, Math.max(0, (segment.duration ?? 0) - 0.05))
      } catch { /* seeking before metadata is a no-op */ }
    }
    this.playing = wasPlaying
    if (wasPlaying) {
      try {
        await audio?.play()
      } catch (error) {
        this.playing = false
        this.#report(error)
      }
    } else {
      this.#setPhase('paused')
    }
    this.#emit()
    return this.phase
  }

  /**
   * Change the voice (and optionally the engine) for everything not yet
   * synthesised. Audio already produced keeps its own voice, so switching
   * never rewrites the timeline under the playhead.
   *
   * @param voice - voice id, or '' for the engine default.
   * @param engine - engine override, or null to keep the configured one.
   */
  /**
   * Change the voice for the text currently being read.
   *
   * Everything the current reading holds is re-queued, not just the text that
   * has not been synthesised yet. That matters because auto-read usually
   * finishes synthesising a short reply long before the reader has heard all of
   * it: without re-queueing, the already-produced audio would keep the old
   * voice and the switch would look like it did nothing at all.
   *
   * Switching when nothing is being read only arms the override; the next
   * reply is spoken with the new voice.
   *
   * @param voice - voice id, or '' for the engine default.
   * @param engine - engine override, or null to keep the configured one.
   * @returns true when a live reading was re-queued with the new voice.
   */
  setVoice(voice, engine = null) {
    this.voiceOverride = voice === '' ? '' : voice
    this.engineOverride = engine
    if (this.segments.length === 0) {
      this.#emit()
      return false
    }
    this.#revoice()
    return true
  }

  /**
   * Change the speaking speed.
   *
   * Speed is applied at PLAYBACK, not at synthesis: the audio is always produced
   * once at a natural pace and the media element scales it, keeping the pitch
   * (measured 2026-10-05: the neural service caps its own speed-up, because
   * `+100%`, `+150%` and `+200%` all returned byte-identical audio). Playback
   * scaling also means a speed change is instant and never re-queues the
   * reading, so the timeline does not shift under the listener.
   *
   * @param multiplier - `0.5` … `2`; 1 is natural pace.
   */
  setRate(multiplier) {
    const value = typeof multiplier === 'number' && Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1
    this.rateMultiplier = value
    const audio = this.audio
    if (audio !== null) {
      try {
        audio.playbackRate = value
        // Chromium preserves pitch by default; state it so a future default
        // change cannot make a fast reading sound like a chipmunk.
        audio.preservesPitch = true
        audio.mozPreservesPitch = true
        audio.webkitPreservesPitch = true
      } catch { /* an element without a source has nothing to scale */ }
    }
    this.#emit()
    return value
  }

  /**
   * Throw away every segment of the current reading and rebuild it from the
   * same text, so the whole timeline is produced with the current voice and rate.
   */
  #revoice() {
    const wasPlaying = this.playing
    const meta = {
      sessionId: this.current?.sessionId ?? '',
      turn: this.current?.turn ?? null,
      reason: this.current?.reason ?? 'live',
    }
    const texts = this.segments.map((segment) => segment.text).filter((text) => text.trim() !== '')
    this.#stopAudio()
    this.#resetMedia()
    for (const segment of this.segments) this.#release(segment)
    this.segments = []
    this.cursor = -1
    this.playing = false
    this.finished = false
    this.activeLoads = 0
    this.wanted.clear()
    this.#emit()
    if (texts.length === 0) {
      this.#setPhase('idle')
      return
    }
    this.enqueue(texts, meta)
    this.end()
    if (wasPlaying) void this.play()
  }

  /**
   * Read one text from the beginning, replacing whatever is being read.
   *
   * This is what the per-message speaker button and the settings panel's
   * "re-read" action call: it remembers the text so the same message can be
   * re-read in a newly chosen voice without going back to the session log.
   *
   * @param text - the text to read.
   * @param meta - `{ sessionId, turn, reason }`.
   * @returns the number of segments queued (0 when the text is silent).
   */
  async playText(text, meta = {}) {
    const clean = typeof text === 'string' ? text.trim() : ''
    this.reset()
    if (clean === '') return 0
    this.replayText = clean
    // A whole reply can be far longer than one synthesis request allows, so the
    // cut is bounded by the host's own ceiling as well as the clause limit.
    const segments = segmentsOf(clean, this.softChunkChars, this.maxCharsPerRequest)
    if (segments.length === 0) return 0
    this.enqueue(segments, { reason: 'replay', ...meta })
    this.end()
    await this.play()
    return segments.length
  }

  /** Release every object URL and pending request. */
  dispose() {
    this.reset()
    if (this.audio !== null) {
      this.audio.removeAttribute('src')
      this.audio.load?.()
    }
  }

  /**
   * Take the media element back to a blank resource.
   *
   * Reusing one element across a source swap is the one place a browser can
   * keep serving the previous decode; clearing the resource forces it to decode
   * the audio this reading actually produced.
   */
  #resetMedia() {
    const audio = this.audio
    if (audio === null) return
    try {
      audio.removeAttribute('src')
      audio.load?.()
    } catch { /* an element without a resource has nothing to reset */ }
  }

  /** Stop the audio element and forget which segment owned it. */
  #stopAudio() {
    const audio = this.audio
    if (audio !== null) {
      try {
        audio.pause()
      } catch { /* a detached element is already silent */ }
    }
  }

  /** Play the next ready segment at or after the playhead. */
  async #advance(from) {
    if (!this.playing) return
    const start = typeof from === 'number' ? from : this.#resumeIndex()
    for (let index = start; index < this.segments.length; index += 1) {
      const segment = this.segments[index]
      if (segment.state === SEGMENT.DONE || segment.state === SEGMENT.ERROR) {
        this.settledThrough = Math.max(this.settledThrough, index)
        continue
      }
      this.#setPhase('buffering')
      this.#emit()
      await this.#load(index)
      if (segment.state === SEGMENT.ERROR) continue
      if (segment.state !== SEGMENT.READY) break
      this.cursor = index
      if (segment.pageSpoken === true) {
        const spoken = await this.#speakInPage(segment)
        segment.state = spoken ? SEGMENT.DONE : SEGMENT.ERROR
        if (!this.playing) {
          this.#emit()
          return
        }
        continue
      }
      const audio = this.audio
      if (audio === null) {
        // No media element (a hostile environment): mark it played so the
        // queue still drains instead of spinning.
        segment.state = SEGMENT.DONE
        segment.duration = 0
        continue
      }
      try {
        // Idempotent: assigning `src` restarts the load and aborts a `play()`
        // that is already in flight (`AbortError: interrupted by a new load`).
        if (audio.src !== segment.url) {
          audio.src = segment.url
          audio.currentTime = 0
        } else if (audio.currentTime > 0.05) {
          audio.currentTime = 0
        }
        audio.playbackRate = this.rateMultiplier > 0 ? this.rateMultiplier : 1
        audio.preservesPitch = true
        await audio.play()
        voiceLog.add('media', `开始播放 #${String(index)} declared=${String(segment.duration)}s src=${audio.src === '' ? '(empty)' : 'blob'} paused=${String(audio.paused)}`)
        if (globalThis.__DSH_VOICE_TRACE__ === true) {
          const now = Date.now()
          this.#trace(segment, index, now)
        }
        this.#setPhase('playing')
        this.#emit()
        this.#pump()
        return
      } catch (error) {
        // `AbortError` means the request lost a race with another load of the
        // same element, not that playback is impossible. Retrying once settles
        // it; treating it as fatal used to stop the whole reading and leave the
        // reader reporting "paused" with segments still queued.
        const aborted = error instanceof Error && error.name === 'AbortError'
        voiceLog.add('media', `play() 被拒 #${String(index)}${aborted ? '（被新的加载打断，重试）' : ''}：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
        if (aborted && !this.retryingAbort) {
          this.retryingAbort = true
          await new Promise((resolve) => setTimeout(resolve, 60))
          try {
            if (audio.src !== segment.url) audio.src = segment.url
            audio.currentTime = 0
            await audio.play()
            this.retryingAbort = false
            this.#setPhase('playing')
            this.#emit()
            this.#pump()
            return
          } catch (retryError) {
            this.retryingAbort = false
            this.#report(retryError)
          }
        }
        this.playing = false
        this.#setPhase('paused')
        this.#report(error)
        this.#emit()
        return
      }
    }
    // Nothing playable left.
    if (this.finished || this.#allSettled()) {
      this.playing = false
      this.cursor = this.segments.length
      this.#setPhase(this.segments.length === 0 ? 'idle' : 'paused')
    } else {
      // More text is still streaming in.
      this.cursor = this.segments.length
      this.#setPhase('buffering')
      this.#pump()
    }
    this.#emit()
  }

  /**
   * Speak one segment with the page's own Web Speech voice.
   *
   * @param segment - the segment to speak.
   * @returns true when it was spoken to completion.
   */
  #speakInPage(segment) {
    const synth = globalThis.speechSynthesis
    const Utterance = globalThis.SpeechSynthesisUtterance
    if (synth === undefined || typeof Utterance !== 'function') {
      segment.error = '此浏览器不支持 Web Speech 语音合成。'
      this.#report(new Error(segment.error))
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      const utterance = new Utterance(segment.text)
      const settings = this.getSettings() ?? {}
      const rate = Number(settings.rate)
      utterance.rate = Number.isFinite(rate) && rate > 0 ? Math.min(4, Math.max(0.4, rate)) : 1
      utterance.onend = () => { resolve(true) }
      utterance.onerror = (event) => {
        segment.error = `页面语音失败：${event?.error ?? 'unknown'}`
        this.#report(new Error(segment.error))
        resolve(false)
      }
      try {
        synth.speak(utterance)
      } catch (error) {
        segment.error = error instanceof Error ? error.message : String(error)
        this.#report(error)
        resolve(false)
      }
    })
  }

  /**
   * The media element finished one segment: retire it and move to the next.
   *
   * The cursor is deliberately NOT advanced here: {@link #advance} starts at
   * `cursor + 1`, so bumping it as well would skip the segment right after the
   * one that just ended.
   */
  async #onEnded() {
    const segment = this.segments[this.cursor]
    if (segment !== undefined && this.#endedTooEarly(segment) && (segment.replays ?? 0) < REPLAY_ATTEMPTS) {
      // An `ended` event also fires when the media element stops long before the
      // end of the audio it was given — a stalled or partially decoded stream,
      // for example. Treated as a normal end, that is heard as the reading
      // stopping in the middle of a sentence, which is indistinguishable from
      // the reply having ended. Replaying is cheap; losing the sentence is not.
      segment.replays = (segment.replays ?? 0) + 1
      const playedFor = this.audio?.currentTime ?? 0
      segment.playedBeforeReplay = playedFor
      voiceLog.add('play', `#${String(this.cursor)} 未播完（${playedFor.toFixed(1)}s / ${(segment.duration || 0).toFixed(1)}s），第 ${String(segment.replays)} 次重播`)
      await this.#replay(segment)
      this.#emit()
      return
    }
    if (segment !== undefined) {
      segment.state = SEGMENT.DONE
      this.settledThrough = Math.max(this.settledThrough, this.cursor)
      // Trust the media element only while it still owns this segment's audio:
      // a replaced `src` would report another segment's duration here.
      const audio = this.audio
      if (audio !== null && audio.src === segment.url && Number.isFinite(audio.duration) && audio.duration > 0) {
        segment.duration = audio.duration
      }
    }
    if (!this.playing) {
      this.#emit()
      return
    }
    void this.#advance()
    this.#emit()
  }

  /** The media element failed: skip the segment and keep reading. */
  #onAudioError() {
    const segment = this.segments[this.cursor]
    if (segment !== undefined) {
      segment.state = SEGMENT.ERROR
      this.settledThrough = Math.max(this.settledThrough, this.cursor)
      const code = this.audio?.error?.code ?? '?'
      const message = this.audio?.error?.message ?? ''
      voiceLog.add('media', `播放失败 #${String(this.cursor)} code=${String(code)} ${message} src=${segment.url === null ? '(none)' : 'blob'} bytes=${String(segment.bytes ?? '?')}`)
      this.#report(new Error(`音频播放失败：${segment.text.slice(0, 30)}`))
    }
    if (!this.playing) {
      this.#emit()
      return
    }
    void this.#advance()
    this.#emit()
  }

  /**
   * Diagnostic trail for the transport: with `globalThis.__DSH_VOICE_TRACE__`
   * set, every segment start is recorded with the elapsed time since the
   * previous start, so a skipped or truncated segment is visible as a gap
   * rather than inferred from the clock.
   *
   * @param segment - the segment that started playing.
   * @param index - its position in the timeline.
   * @param at - epoch milliseconds of the start.
   */
  #trace(segment, index, at) {
    const previous = this.#lastStart
    this.#lastStart = at
    const entry = {
      index,
      at,
      sincePreviousMs: previous === undefined ? 0 : at - previous,
      declared: +(segment.duration ?? 0).toFixed(2),
      text: segment.text.slice(0, 18),
    }
    const trail = (globalThis.__DSH_VOICE_TRAIL__ ??= [])
    trail.push(entry)
    globalThis.console?.debug?.('[dsh-voice] segment start', entry)
  }

  /** True when no segment is still pending or loading. */
  #allSettled() {
    return this.segments.every((segment) => segment.state === SEGMENT.DONE || segment.state === SEGMENT.ERROR)
  }

  /** Ask the host for one segment's audio (idempotent per segment). */
  async #load(index) {
    const segment = this.segments[index]
    if (segment === undefined) return
    if (segment.state === SEGMENT.READY || segment.state === SEGMENT.DONE) return
    if (segment.promise !== null) {
      await segment.promise
      return
    }
    segment.state = SEGMENT.LOADING
    this.#emit()
    // Claim the promise cell with the ACTUAL work, synchronously. The body
    // starts with awaits, so a concurrent caller (the prefetch pump and the
    // playback advance both call this) could otherwise slip past the guard and
    // request the same segment again — four requests for one segment were
    // observed in the wild.
    //
    // A separate placeholder promise would deadlock: the second caller awaits
    // the cell, and the first would be awaiting its own placeholder.
    segment.promise = (async () => {
      const settings = this.getSettings() ?? {}
      const body = {
        text: segment.text,
        voice: this.voiceOverride ?? (typeof settings.voice === 'string' ? settings.voice : ''),
        engine: this.engineOverride ?? (typeof settings.engine === 'string' ? settings.engine : 'auto'),
      }
      // Round-trip trail for the settings surface: it shows what the page
      // asked for and what the host actually spoke, so a mismatch between the
      // picker, the settings and the audio is visible instead of guessed at.
      const trace = {
        at: Date.now(),
        index,
        asked: body.voice,
        override: this.voiceOverride,
        settingsVoice: settings.voice,
        spoke: '',
        engine: body.engine,
        cached: false,
        text: segment.text.slice(0, 12),
        error: '',
      }
      this.requests.push(trace)
      if (this.requests.length > REQUEST_TRAIL) this.requests.splice(0, this.requests.length - REQUEST_TRAIL)
      if (body.engine === 'browser') {
        // No host synthesis: the page speaks it itself. The timeline is then
        // an estimate, so seeking inside the segment is approximate.
        segment.pageSpoken = true
        segment.duration = estimateSpeechSeconds(segment.text, 1)
        segment.voice = body.voice
        segment.engine = 'browser'
        segment.state = SEGMENT.READY
        return
      }
      voiceLog.add('fetch', `#${String(index)} POST /voice/segment voice=${body.voice === '' ? '(默认)' : body.voice} engine=${body.engine} text=${segment.text.slice(0, 14)}`)
      let response
      for (let attempt = 1; attempt <= SYNTH_ATTEMPTS; attempt += 1) {
        try {
          response = await fetch(`${this.baseUrl}/voice/segment?t=${String(Date.now())}-${String(index)}-${String(attempt)}`, {
            cache: 'no-store',
            method: 'POST',
            // `text/plain` keeps this a CORS "simple request": a JSON content
            // type would trigger a preflight that the desktop shell's
            // cross-origin page cannot complete. The host parses the body
            // regardless.
            headers: { 'content-type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify(body),
          })
        } catch (error) {
          // A transport failure (offline, CSP, refused connection) never reaches
          // the status check below, so it is logged here.
          voiceLog.add('fetch', `#${String(index)} 第 ${String(attempt)} 次传输失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
          if (attempt < SYNTH_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, SYNTH_RETRY_MS * 2 ** (attempt - 1)))
            continue
          }
          trace.error = '传输失败'
          throw error
        }
        if (response.ok) break
        // A 4xx is this request's own fault and will not improve by repeating it.
        if (response.status < 500) break
        voiceLog.add('fetch', `#${String(index)} 第 ${String(attempt)} 次返回 HTTP ${String(response.status)}，将重试`)
        if (attempt < SYNTH_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, SYNTH_RETRY_MS * 2 ** (attempt - 1)))
        }
      }
      trace.spoke = response.headers.get('x-voice-voice') ?? ''
      const noticeHeader = response.headers.get('x-voice-notice')
      trace.notice = noticeHeader === null || noticeHeader === '' ? '' : decodeURIComponent(noticeHeader)
      if (trace.notice !== '') voiceLog.add('voice', `#${String(index)} ${trace.notice}`)
      trace.cached = response.headers.get('x-voice-cached') === '1'
      voiceLog.add('fetch', `#${String(index)} POST /voice/segment -> HTTP ${String(response.status)} bytes=${String(response.headers.get('content-length') ?? '?')} spoke=${trace.spoke} cached=${String(trace.cached)}`)
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        let message = `合成失败（HTTP ${response.status}）`
        try {
          const parsed = JSON.parse(detail)
          if (typeof parsed?.error === 'string') message = parsed.error
        } catch { /* a non-JSON error body keeps the status message */ }
        const failure = new Error(message)
        failure.status = response.status
        trace.error = message
        throw failure
      }
      const blob = await response.blob()
      const header = (name) => response.headers.get(name) ?? ''
      trace.bytes = blob.size
      trace.fingerprint = await fingerprintOf(blob)
      const duration = Number(header('x-voice-duration'))
      segment.url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : ''
      segment.duration = Number.isFinite(duration) && duration > 0 ? duration : 0
      segment.voice = header('x-voice-voice') === '' ? body.voice : decodeURIComponent(header('x-voice-voice'))
      segment.engine = header('x-voice-engine')
      segment.cached = header('x-voice-cached') === '1'
      segment.notice = trace.notice ?? ''
      segment.fingerprint = trace.fingerprint
      segment.bytes = blob.size
      segment.state = SEGMENT.READY
    })()
    try {
      // Awaited twice on purpose: the first await is this call's own work, the
      // second is the shared cell in case another caller replaced it.
      await segment.promise
      // A browser engine answer still needs a timeline: ask the media element
      // for the real duration once it knows it.
      await this.#measure(segment)
    } catch (error) {
      segment.state = SEGMENT.ERROR
      segment.error = error instanceof Error ? error.message : String(error)
      this.#report(error)
    } finally {
      // Release the cell here, after this call's awaits have settled. The
      // earlier release lived inside the body, where it emptied the guard while
      // `#load` was still suspended; the guard is now claimed synchronously,
      // which is what actually closes that window.
      segment.promise = null
      this.#emit()
    }
  }

  /**
   * Fill in a missing duration from the media element's own metadata.
   *
   * Each measurement gets its own element: assigning `src` on a shared one
   * cancels the previous metadata load, so two concurrent measurements would
   * both read the second segment's duration. The host's parsed duration is
   * preferred and skips this path entirely.
   */
  async #measure(segment) {
    if (segment.duration > 0 || segment.url === '' || this.audio === null) return
    const element = globalThis.document?.createElement?.('audio') ?? undefined
    if (element === undefined) return
    const measured = await new Promise((resolve) => {
      const timer = setTimeout(() => { resolve(0) }, 4000)
      element.addEventListener('loadedmetadata', () => {
        clearTimeout(timer)
        resolve(Number.isFinite(element.duration) ? element.duration : 0)
      }, { once: true })
      element.addEventListener('error', () => { clearTimeout(timer); resolve(0) }, { once: true })
      element.src = segment.url
    })
    if (measured > 0) segment.duration = measured
  }

  /** Release one segment's object URL. */
  #release(segment) {
    if (segment.url !== null && segment.url !== '' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(segment.url)
    }
    segment.url = null
  }

  /** Keep the synthesis pipeline busy up to its concurrency limit. */
  #pump() {
    while (this.activeLoads < SYNTH_CONCURRENCY) {
      const index = this.#nextToLoad()
      if (index < 0) return
      this.activeLoads += 1
      void this.#load(index).finally(() => {
        this.activeLoads -= 1
        this.#pump()
      })
    }
  }

  /** The next segment worth synthesising: near the playhead, in order. */
  #nextToLoad() {
    const from = Math.max(0, this.currentIndex)
    for (let index = from; index < this.segments.length; index += 1) {
      const segment = this.segments[index]
      if (segment.state !== SEGMENT.PENDING) continue
      if (index - from > PREFETCH_AHEAD) return -1
      return index
    }
    return -1
  }

  /** Set the phase and notify. */
  #setPhase(phase) {
    if (this.phase === phase) return
    this.phase = phase
    this.#emit()
  }

  /** Report a failure without breaking the caller. */
  #report(error) {
    try {
      this.onError(error)
    } catch { /* a throwing reporter never stops the transport */ }
  }

  /** Publish a status snapshot to the console. */
  #emit() {
    try {
      this.onUpdate(this.snapshot())
    } catch { /* a throwing listener never stops the transport */ }
  }

  /** The immutable status snapshot the UI renders. */
  snapshot() {
    const current = this.current
    return {
      phase: this.phase,
      playing: this.playing,
      finished: this.finished,
      size: this.segments.length,
      index: this.currentIndex,
      position: this.position,
      duration: this.duration,
      offset: this.currentOffset,
      segmentDuration: current?.duration ?? 0,
      text: current?.text ?? '',
      sessionId: current?.sessionId ?? '',
      turn: current?.turn ?? null,
      reason: current?.reason ?? '',
      hasReading: this.segments.length > 0,
      voice: current?.voice ?? this.voiceOverride ?? '',
      fingerprint: current?.fingerprint ?? '',
      engine: current?.engine ?? '',
      voiceOverride: this.voiceOverride,
      settingsVoice: (this.getSettings() ?? {}).voice ?? '',
      requests: this.requests.slice(-6),
      rate: this.rateMultiplier,
      voiceNotice: this.segments.map((segment) => segment.notice).find((text) => typeof text === 'string' && text !== '') ?? '',
      ready: this.segments.filter((segment) => segment.state === SEGMENT.READY).length,
      pending: this.segments.filter((segment) => segment.state === SEGMENT.PENDING || segment.state === SEGMENT.LOADING).length,
      errors: this.segments.filter((segment) => segment.state === SEGMENT.ERROR).length,
    }
  }
}
