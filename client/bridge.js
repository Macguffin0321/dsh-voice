/**
 * The browser's half of the voice loop: talking to the host, following the
 * session's live text, and keeping one reading per session.
 *
 * There are two independent ways text reaches the reader, and both are needed:
 *
 * - **Live streaming** (`agent/assistant-stream` → `/voice/live`) gives the
 *   deltas while the model is still writing, which is what makes the reading
 *   feel immediate rather than arriving after the reply.
 * - **The session event window** (`sessions.binding(id).eventSource`) is the
 *   authoritative record: it carries the settled `assistant/message`, which is
 *   what the per-message speaker button replays and what a reader who joins
 *   mid-turn hears from the start.
 *
 * @module dsh-voice/client/bridge
 */

import { cutSegments, sanitizeSpeech, silentText } from './sanitize.js'

/** How long to wait before re-opening the live socket. */
const RECONNECT_MS = 1500

/** Socket failures after which the polling transport takes over. */
const POLL_AFTER_FAILURES = 2

/** Polling cadence in milliseconds. */
const POLL_MS = 600

/**
 * How far back to look for a code-fence opener that is still being streamed.
 *
 * A fence marker is at most three backticks (or tildes) plus indentation, so a
 * tail longer than this cannot still be one.
 */
const FENCE_TAIL_LIMIT = 8

/** One session's reading state. */
class SessionReader {
  constructor(sessionId) {
    this.sessionId = sessionId
    /** Every character received for this attempt, verbatim. */
    this.raw = ''
    /** How much of {@link raw} is past any fence and safe to sanitize. */
    this.rawCursor = 0
    /** How much of the sanitized text has already been spoken. */
    this.cleanCursor = 0
    /** Text already handed to the reader for this attempt. */
    this.streamed = ''
    /** Attempt identity of the live turn. */
    this.attemptId = ''
    /** True while a live turn is open. */
    this.live = false
    /** True once the durable settlement was folded in. */
    this.settled = false
  }
}

/**
 * Where the stream becomes safe to read out.
 *
 * A fence arrives across several deltas — one may end with a single backtick and
 * the next may start with two more — so "is the stream inside a code block right
 * now" is state, not something a per-chunk regex can answer.
 *
 * @param text - the accumulated raw text.
 * @returns the offset up to which the text is settled.
 */
function settledLength(text) {
  // Markdown separates blocks with a blank line, so everything up to the last
  // blank line can no longer change. The block after it is still arriving and is
  // withheld.
  //
  // This is the only safe boundary. Two structures taught that the hard way:
  //  * a table row is not recognisable until its closing pipe arrives, and a
  //    prefix of it ("完全不出声，") reads as ordinary prose — so a partly
  //    arrived row that is released is spoken, and speech cannot be undone;
  //  * a code fence opens on one line and closes on another, so a released
  //    fragment loses its own context.
  // Both live inside the final block, so holding that block back settles both
  // without the sanitizer needing to know they are half-arrived.
  const lastBlank = /\n[ \t]*\n(?!\s*$)/gu
  let boundary = 0
  for (const match of text.matchAll(lastBlank)) {
    boundary = match.index + match[0].length
  }
  // Withholding the whole arriving block costs the first words of a short
  // reply: a two-sentence answer has no blank line until it ends, so it would
  // stay silent and then speak everything at once. When what arrived since the
  // last blank line shows no sign of a table or a fence, its complete lines are
  // ordinary prose and can go out immediately.
  const arriving = text.slice(boundary)
  const structural = /[|`~]/u.test(arriving)
  if (structural) return boundary
  const lastNewline = text.lastIndexOf('\n')
  return lastNewline >= boundary ? lastNewline + 1 : boundary
}

/**
 * Whether a finished turn stopped in the middle of a sentence.
 *
 * The model can be cut off by a token limit or a cancelled stream, and the text
 * it did produce is real — so it is spoken. But it must not be presented as a
 * complete answer, because "the reply was truncated" and "I missed the ending"
 * sound identical. Only the text can distinguish them.
 *
 * @param text - the raw text the turn produced.
 * @returns true when the text does not end at a natural stop.
 */
export function looksUnfinished(text) {
  const trimmed = text.trim()
  if (trimmed === '') return false
  // A trailing sentence end, a list item, a table row or a fence all count as
  // deliberate stops.
  if (/[。！？…!?]$/u.test(trimmed)) return false
  if (/[。）)】」』”"'*_~\]]$/u.test(trimmed)) return false
  if (/[|`~]$/u.test(trimmed)) return false
  if (/[：:]$/u.test(trimmed)) return false
  return true
}

/**
 * Cut every sentence that has become available and sanitize it.
 *
 * The sanitizer always runs over the WHOLE accumulated raw text, and a cursor
 * records how much of that result has already been spoken. Sanitizing each delta
 * on its own cannot work: a fence opener arriving before its body makes the
 * sanitizer drop the prose in between, and the body then reads as ordinary text.
 *
 * @param reader - the session's reading state.
 * @param final - true when the turn ended.
 * @param softChunkChars - the unpunctuated clause limit.
 * @returns the speakable segments, in order.
 */
function drainReader(reader, final, softChunkChars) {
  const raw = reader.raw
  if (raw === '') return []
  // Nothing is withheld once the turn is over: a fence the model never closed
  // should still have its body suppressed, and the sanitizer does that.
  const limit = final ? raw.length : settledLength(raw)
  if (limit <= reader.rawCursor) return []
  const sanitized = sanitizeSpeech(raw.slice(0, limit))
  const pending = sanitized.slice(reader.cleanCursor)
  const cut = cutSegments(pending, softChunkChars, final)
  reader.cleanCursor = final ? sanitized.length : sanitized.length - cut.rest.length
  // The cursor may only advance inside the settled prefix.
  reader.rawCursor = limit
  const out = []
  for (const segment of cut.segments) {
    if (segment.trim() === '') continue
    out.push(segment)
  }
  return out
}

/**
 * Cut every sentence that has become available and sanitize it.
 *
 * @param reader - the session's reading state.
 * @param final - true when the turn ended.
 * @param softChunkChars - the unpunctuated clause limit.
 * @returns the speakable segments, in order.
 */

/**
 * The bridge. It owns the settings, the voice roster, the live transport, and
 * one {@link SessionReader} per session; the audio engine itself lives in
 * `speak.js` and is driven through the callbacks this class is given.
 */
export class VoiceBridge {
  /**
   * @param options - `{ baseUrl, sessions, onLive, onStatus, onError }`.
   */
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? ''
    this.sessions = options.sessions
    this.onLive = options.onLive ?? (() => {})
    this.onStatus = options.onStatus ?? (() => {})
    this.onError = options.onError ?? (() => {})

    this.closed = false
    this.socket = null
    this.socketSession = ''
    this.socketFailures = 0
    /** Frames already consumed (polling cursor). */
    this.cursor = 0
    this.polling = false
    /** @type {ReturnType<typeof setInterval> | undefined} */
    this.pollTimer = undefined
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.reconnectTimer = undefined

    /** @type {Map<string, SessionReader>} */
    this.readers = new Map()
    /** @type {Map<string, () => void>} */
    this.eventSubscriptions = new Map()

    this.settings = {
      enabled: true,
      autoRead: true,
      readOnSettle: false,
      softChunkChars: 40,
      maxCharsPerRequest: 800,
      engine: 'auto',
      voice: '',
      rate: 0,
    }
    this.voices = []
    this.voicesEngine = ''
    /** The engine the host resolved (`edge` | `local` | `browser`). */
    this.resolved = ''
    this.capabilities = null
    this.hostReady = false
    /** The session the live transport is following (the visible one). */
    this.focusSession = ''
  }

  /** Fetch the host snapshot once at startup. */
  async refresh() {
    try {
      const response = await fetch(`${this.baseUrl}/voice/status`, { method: 'GET', cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      this.hostReady = true
      this.capabilities = payload.capabilities ?? null
      this.resolved = typeof payload.resolved === 'string' ? payload.resolved : ''
      this.settings = {
        ...this.settings,
        enabled: payload.enabled !== false,
        autoRead: payload.autoRead !== false,
        readOnSettle: payload.readOnSettle === true,
        softChunkChars: numberOr(payload.softChunkChars, 40),
        maxCharsPerRequest: numberOr(payload.maxCharsPerRequest, 800),
        engine: typeof payload.engine === 'string' ? payload.engine : 'auto',
        voice: typeof payload.configuredVoice === 'string' ? payload.configuredVoice : '',
        rate: numberOr(payload.rate, 0),
      }
      this.onStatus({ settings: this.settings, resolved: this.resolved, capabilities: this.capabilities, hostReady: true })
      return true
    } catch (error) {
      this.hostReady = false
      this.onStatus({ settings: this.settings, resolved: '', capabilities: null, hostReady: false })
      this.onError(error)
      return false
    }
  }

  /**
   * Load the voice roster for one engine.
   *
   * `auto` is resolved by the host, so the same value is sent and the answer
   * reports which engine was actually enumerated.
   */
  async loadVoices(engine) {
    const wanted = engine ?? this.settings.engine
    try {
      const response = await fetch(`${this.baseUrl}/voice/voices?engine=${encodeURIComponent(wanted)}`, { method: 'GET', cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      this.voices = Array.isArray(payload.voices) ? payload.voices : []
      this.voicesEngine = typeof payload.engine === 'string' ? payload.engine : wanted
      if (this.voicesEngine === 'edge' || this.voicesEngine === 'local') this.resolved = this.voicesEngine
      this.onStatus({ voices: this.voices, voicesEngine: this.voicesEngine, resolved: this.resolved })
      return this.voices
    } catch (error) {
      this.voices = []
      this.voicesEngine = wanted
      this.onError(error)
      this.onStatus({ voices: [], voicesEngine: wanted })
      return []
    }
  }

  /** Persist a settings change on the host and adopt the answer. */
  async updateSettings(patch) {
    try {
      const response = await fetch(`${this.baseUrl}/voice/settings`, {
        cache: 'no-store',
        method: 'POST',
        // A simple request: a JSON content type would trigger a preflight the
        // desktop shell's cross-origin page cannot complete. The host parses
        // the body regardless of the declared type.
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(patch),
      })
      const payload = await response.json().catch(() => ({}))
      if (payload.settings !== undefined && !Array.isArray(payload.settings)) {
        this.settings = { ...this.settings, ...payload.settings }
      } else {
        this.settings = { ...this.settings, ...patch }
      }
      if (Array.isArray(payload.issues) && payload.issues.length > 0) {
        this.onError(new Error(payload.issues.join(' ')))
      }
      this.onStatus({ settings: this.settings })
      if (patch.engine !== undefined) await this.loadVoices(patch.engine)
      return response.ok
    } catch (error) {
      this.onError(error)
      return false
    }
  }

  /**
   * Point the live transport at one session. The console and the per-message
   * button both call this; only a change re-opens the socket.
   *
   * @param sessionId - the session whose assistant text to follow.
   */
  focus(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (this.focusSession === sessionId && this.socket !== null) return
    this.focusSession = sessionId
    this.cursor = 0
    this.socketFailures = 0
    this.polling = false
    this.stopPolling()
    this.openSocket(sessionId)
    this.observeEvents(sessionId)
  }

  /** Stop following anything (the voice loop is switched off). */
  blur() {
    this.closeSocket()
    this.stopPolling()
    this.focusSession = ''
  }

  /** Stop every transport and drop every subscription. */
  dispose() {
    this.closed = true
    this.closeSocket()
    this.stopPolling()
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    for (const off of this.eventSubscriptions.values()) {
      try {
        off()
      } catch { /* a disposed session subscription is already gone */ }
    }
    this.eventSubscriptions.clear()
    this.readers.clear()
  }

  /**
   * Read one settled assistant message's text from the session event window.
   *
   * @param sessionId - the session holding the message.
   * @param messageId - the durable message identity from the action row.
   * @returns the message text, or '' when it is not loaded.
   */
  messageText(sessionId, messageId) {
    const entries = this.entries(sessionId)
    if (entries === undefined || typeof messageId !== 'string') return ''
    for (const entry of entries) {
      const event = entry?.event
      if (event?.type !== 'assistant/message') continue
      if (messageIdOf(event.data) !== messageId) continue
      const text = textOfAssistantData(event.data)
      if (text !== '') return text
    }
    return ''
  }

  /**
   * Read one turn's settled assistant text from the session event window.
   *
   * @param sessionId - the session holding the turn.
   * @param turn - the turn number.
   * @returns the turn's assistant text, or '' when it is not loaded.
   */
  turnText(sessionId, turn) {
    const entries = this.entries(sessionId)
    if (entries === undefined || typeof turn !== 'number') return ''
    let text = ''
    for (const entry of entries) {
      const event = entry?.event
      if (event?.type !== 'assistant/message') continue
      if (event.data?.turn !== turn) continue
      const candidate = textOfAssistantData(event.data)
      if (candidate === '') continue
      text = text === '' ? candidate : `${text}\n\n${candidate}`
    }
    return text
  }

  /** The session event window, or undefined when the session is not loaded. */
  entries(sessionId) {
    const session = this.session(sessionId)
    const source = this.eventSource(session)
    if (source === undefined || typeof source.getSnapshot !== 'function') return undefined
    const snapshot = source.getSnapshot()
    return Array.isArray(snapshot?.entries) ? snapshot.entries : undefined
  }

  /** Resolve the session object for one id, tolerating both binding shapes. */
  session(sessionId) {
    const sessions = this.sessions
    if (sessions === undefined || sessions === null) return undefined
    try {
      if (typeof sessions.binding === 'function') {
        const binding = sessions.binding(sessionId)
        if (binding !== undefined && binding !== null) return binding.session ?? binding
      }
      if (typeof sessions.session === 'function') return sessions.session(sessionId)
      if (typeof sessions.get === 'function') return sessions.get(sessionId)
    } catch { /* an unknown session is not an error here */ }
    return undefined
  }

  /** Find the session's event source across the shapes the client has used. */
  eventSource(session) {
    if (session === undefined || session === null) return undefined
    return session.eventSource ?? session.events?.source ?? session.events ?? undefined
  }

  /**
   * Subscribe to one session's event window so a settled message can be read
   * back even after the live turn ended.
   */
  observeEvents(sessionId) {
    if (this.eventSubscriptions.has(sessionId)) return
    const source = this.eventSource(this.session(sessionId))
    if (source === undefined || typeof source.subscribe !== 'function') return
    const listener = () => {
      const reader = this.readers.get(sessionId)
      if (reader !== undefined) this.foldSettled(reader)
    }
    try {
      const off = source.subscribe(listener)
      this.eventSubscriptions.set(sessionId, typeof off === 'function' ? off : () => {})
    } catch { /* an unsubscribable source simply has no settled replay */ }
  }

  /** Open (or re-open) the live socket for one session. */
  openSocket(sessionId) {
    this.closeSocket()
    if (this.closed || typeof globalThis.WebSocket !== 'function') {
      this.startPolling(sessionId)
      return
    }
    let socket
    try {
      socket = new WebSocket(`${wsBase(this.baseUrl)}/voice/live?sessionId=${encodeURIComponent(sessionId)}`)
    } catch (error) {
      this.onError(error)
      this.startPolling(sessionId)
      return
    }
    this.socket = socket
    this.socketSession = sessionId
    socket.addEventListener('open', () => { this.socketFailures = 0 })
    socket.addEventListener('message', (event) => { this.onFrame(sessionId, event.data) })
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.socketFailures += 1
      if (this.socketFailures >= POLL_AFTER_FAILURES) {
        // The push transport is unavailable on this host: the polling route
        // speaks the same frame stream, so the reader never notices.
        this.polling = true
        this.startPolling(sessionId)
        return
      }
      this.scheduleReconnect(sessionId)
    })
    socket.addEventListener('error', () => {
      // The close handler owns reconnection; an error alone is not fatal.
    })
  }

  /** Close the socket without scheduling a reconnect. */
  closeSocket() {
    const socket = this.socket
    this.socket = null
    this.socketSession = ''
    if (socket !== null) {
      try {
        socket.close()
      } catch { /* already closed */ }
    }
  }

  /** Re-open the socket after a short delay (the host may be reloading). */
  scheduleReconnect(sessionId) {
    if (this.closed || this.reconnectTimer !== undefined) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.closed || this.focusSession !== sessionId) return
      this.openSocket(sessionId)
    }, RECONNECT_MS)
  }

  /** Poll `/voice/live` for frames the push transport could not deliver. */
  startPolling(sessionId) {
    if (this.pollTimer !== undefined || this.closed) return
    const tick = async () => {
      if (this.closed || this.focusSession !== sessionId) return
      try {
        const response = await fetch(`${this.baseUrl}/voice/live?sessionId=${encodeURIComponent(sessionId)}&cursor=${String(this.cursor)}`, { method: 'GET', cache: 'no-store' })
        if (!response.ok) {
          // Even the polling route is missing: stop asking rather than spin.
          if (response.status === 404 || response.status === 403) this.stopPolling()
          return
        }
        const payload = await response.json()
        if (payload?.reset === true) this.cursor = 0
        const frames = Array.isArray(payload?.frames) ? payload.frames : []
        for (const frame of frames) {
          if (typeof frame?.seq === 'number' && Number.isFinite(frame.seq)) this.cursor = Math.max(this.cursor, frame.seq)
          this.onFrame(sessionId, JSON.stringify(frame))
        }
        if (typeof payload?.cursor === 'number' && Number.isFinite(payload.cursor)) {
          this.cursor = Math.max(this.cursor, payload.cursor)
        }
      } catch { /* the next tick retries */ }
    }
    this.pollTimer = setInterval(() => { void tick() }, POLL_MS)
    void tick()
  }

  /** Stop the polling transport. */
  stopPolling() {
    if (this.pollTimer === undefined) return
    clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  /** Fold one host frame into the session's reader. */
  onFrame(sessionId, raw) {
    let frame
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    const reader = this.reader(sessionId)
    if (frame?.type === 'start') {
      reader.raw = ''
      reader.rawCursor = 0
      reader.cleanCursor = 0
      reader.streamed = ''
      reader.live = true
      reader.settled = false
      reader.attemptId = typeof frame.attemptId === 'string' ? frame.attemptId : ''
      this.onLive({ kind: 'start', sessionId, turn: numberOr(frame.turn, 0) })
      return
    }
    if (frame?.type === 'delta') {
      const text = typeof frame.text === 'string' ? frame.text : ''
      if (text === '') return
      reader.live = true
      reader.raw += text
      const segments = drainReader(reader, false, this.settings.softChunkChars)
      if (segments.length > 0) {
        reader.streamed += segments.join('')
        this.onLive({ kind: 'segments', sessionId, segments, turn: numberOr(frame.turn, 0), reason: 'live' })
      }
      return
    }
    if (frame?.type === 'end') {
      reader.live = false
      // A turn that stops mid-sentence looks exactly like a reading failure to
      // the listener: they cannot tell a truncated reply from audio they missed.
      // The raw text is the only place that can tell them apart, so it is
      // reported rather than silently spoken as if it were complete.
      const unfinished = looksUnfinished(reader.raw)
      const segments = drainReader(reader, true, this.settings.softChunkChars)
      if (segments.length > 0) {
        reader.streamed += segments.join('')
        this.onLive({ kind: 'segments', sessionId, segments, turn: 0, reason: 'live' })
      }
      this.onLive({ kind: 'end', sessionId, truncated: unfinished })
    }
  }

  /**
   * When a turn settles, the durable message is authoritative. With
   * `readOnSettle` the reader repeats it; without it the fold only records the
   * text so the speaker button can replay it.
   */
  foldSettled(reader) {
    if (reader.settled) return
    const entries = this.entries(reader.sessionId)
    if (entries === undefined) return
    let latest = ''
    let latestTurn = 0
    for (const entry of entries) {
      const event = entry?.event
      if (event?.type !== 'assistant/message') continue
      const text = textOfAssistantData(event.data)
      if (text === '') continue
      latest = text
      latestTurn = numberOr(event.data?.turn, 0)
    }
    if (latest === '') return
    reader.settled = true
    if (this.settings.readOnSettle !== true) return
    const segments = speakable(cutSegments(sanitizeSpeech(latest), this.settings.softChunkChars, true).segments)
    if (segments.length === 0) return
    this.onLive({ kind: 'settle', sessionId: reader.sessionId, segments, turn: latestTurn, reason: 'settle' })
  }

  /** The reader record for one session, created on demand. */
  reader(sessionId) {
    let reader = this.readers.get(sessionId)
    if (reader === undefined) {
      reader = new SessionReader(sessionId)
      this.readers.set(sessionId, reader)
    }
    return reader
  }
}

/** Sanitize and drop segments that carry nothing worth speaking. */
function speakable(segments) {
  const out = []
  for (const segment of segments) {
    const clean = sanitizeSpeech(segment)
    if (clean === '' || silentText(clean)) continue
    out.push(clean)
  }
  return out
}

/** Build the `ws:`/`wss:` origin for one HTTP base. */
function wsBase(baseUrl) {
  if (baseUrl === '' || baseUrl === undefined) {
    const location = globalThis.location
    const protocol = location?.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${location?.host ?? '127.0.0.1'}`
  }
  if (baseUrl.startsWith('https://')) return `wss://${baseUrl.slice('https://'.length)}`
  if (baseUrl.startsWith('http://')) return `ws://${baseUrl.slice('http://'.length)}`
  return baseUrl
}

/**
 * Extract the prose of one `assistant/message` payload.
 *
 * The payload carries `blocks` (text and reasoning parts); only text parts are
 * spoken, and a durable `stream` is used when no blocks are present.
 *
 * @param data - the event payload.
 * @returns the text, or ''.
 */
export function textOfAssistantData(data) {
  if (data === null || typeof data !== 'object') return ''
  const parts = []
  // Shape 1 (0.2 line): `data.message.content` is the assistant message body,
  // an ordered array whose `text` members are the prose and whose `reasoning`
  // members stay out of the voice loop.
  const content = data.message?.content
  if (Array.isArray(content)) {
    for (const member of content) {
      if (member === null || typeof member !== 'object') continue
      if (member.type === 'text' && typeof member.text === 'string') parts.push(member.text)
    }
  }
  // Shape 2: a flattened `blocks` array with `kind: 'text'` members.
  if (parts.length === 0 && Array.isArray(data.blocks)) {
    for (const block of data.blocks) {
      if (block === null || typeof block !== 'object') continue
      if (block.kind === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  if (parts.length > 0) return parts.join('\n\n')
  if (typeof data.text === 'string') return data.text
  // Shape 3: only the recorded model stream survives (a failed attempt).
  const stream = data.stream
  if (stream !== null && typeof stream === 'object') {
    const members = Array.isArray(stream) ? stream : Object.values(stream)
    for (const member of members) {
      const chunk = member?.chunk ?? member
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') parts.push(chunk.text)
    }
  }
  return parts.join('')
}

/** A finite number, or the fallback. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * The durable identity of one `assistant/message` payload.
 *
 * @param data - the event payload.
 * @returns the message id, or '' when the payload carries none.
 */
export function messageIdOf(data) {
  if (data === null || typeof data !== 'object') return ''
  if (typeof data.messageId === 'string') return data.messageId
  if (typeof data.id === 'string') return data.id
  if (typeof data.message?.id === 'string') return data.message.id
  return ''
}
