/**
 * Live assistant-text fan-out.
 *
 * One subscription to the process-local `agent/assistant-stream` frames feeds a
 * per-session ring of normalized frames, and two transports read that ring:
 * a websocket push (`/voice/live`) and a cursor-based poll
 * (`/voice/live?sessionId=&cursor=`) for hosts where the `ws` dependency is not
 * resolvable. Both share the same sequence numbers, so a client may fall back
 * from one to the other without losing or repeating text.
 *
 * Frames carry raw model stream chunks (`text-delta` / `reasoning-delta` / tool
 * calls). Only `text-delta` is spoken; reasoning stays out of the voice loop
 * exactly as it stays out of the transcript's answer text.
 *
 * Deltas are coalesced on a short timer before publication: a model emits
 * hundreds of single-token frames per second, and one message per token would
 * drown the browser. Coalescing keeps sentence boundaries inside a batch, so
 * the client still sees punctuation as soon as the model produces it.
 *
 * @module dsh-voice/live
 */

/** How long deltas accumulate before one publication. */
const FLUSH_MS = 90

/** Per-session retained text ceiling (older text is dropped from the buffer). */
const BUFFER_CAP = 40000

/** Per-session frame ring length. */
const RING = 160

/** One session's in-flight turn text. */
class LiveTurn {
  constructor() {
    /** Text not yet published. */
    this.pending = ''
    /** Whole text published for this attempt so far (reset per attempt). */
    this.text = ''
    /** Attempt identity; a change starts a fresh turn. */
    this.attemptId = ''
    this.turn = 0
    this.step = 0
    /**
     * Whether this step has moved past prose into acting.
     *
     * A tool call follows the model's plan ("I'll start by…"), and that plan is
     * not the answer — the browser drops the step's buffered text when this is
     * set, so only the final reply is spoken.
     */
    this.acting = false
  }
}

/**
 * The host-side bridge. {@link subscribe} pushes frames to one socket,
 * {@link since} serves the polling transport, and {@link dispose} drops the
 * source subscription.
 */
export class LiveTextBridge {
  /** @type {Map<string, Set<(frame: object) => void>>} */
  #watchers = new Map()
  /** @type {Map<string, LiveTurn>} */
  #turns = new Map()
  /** @type {Map<string, { seq: number, frames: object[] }>} */
  #rings = new Map()
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #timer
  /** @type {(() => void) | undefined} */
  #off

  /**
   * @param ctx - host plugin context (its `on` subscribes the agent feed).
   */
  constructor(ctx) {
    this.#off = ctx.on('agent/assistant-stream', (payload) => { this.#accept(payload) })
  }

  /** How many sessions currently hold a live turn (status surface only). */
  get size() {
    return this.#turns.size
  }

  /**
   * Watch one session's deltas over a push transport.
   *
   * @param sessionId - the session whose assistant text to follow.
   * @param send - receives `{ type, seq, ... }` frames.
   * @returns the unsubscribe function.
   */
  subscribe(sessionId, send) {
    let set = this.#watchers.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.#watchers.set(sessionId, set)
    }
    set.add(send)
    const turn = this.#turns.get(sessionId)
    if (turn !== undefined && turn.text !== '') {
      // Late joiner: replay what this attempt already produced so a reader who
      // opens mid-turn does not lose the beginning of the reply.
      const ring = this.#rings.get(sessionId)
      for (const frame of ring?.frames ?? []) send(frame)
    }
    return () => {
      const current = this.#watchers.get(sessionId)
      if (current === undefined) return
      current.delete(send)
      if (current.size === 0) this.#watchers.delete(sessionId)
    }
  }

  /**
   * Read the frames published after one cursor — the polling transport.
   *
   * @param sessionId - the session to read.
   * @param cursor - the last sequence number the caller consumed.
   * @returns `{ cursor, frames, reset }`; `reset` is true when the cursor fell
   *   out of the ring and the caller must start over.
   */
  since(sessionId, cursor) {
    const ring = this.#rings.get(sessionId)
    if (ring === undefined) return { cursor, frames: [], reset: false }
    const oldest = ring.frames.length > 0 ? ring.frames[0].seq : ring.seq
    const reset = cursor < oldest - 1
    const frames = reset ? ring.frames.slice() : ring.frames.filter((frame) => frame.seq > cursor)
    return { cursor: ring.seq, frames, reset }
  }

  /** Drop the source subscription and every watcher. */
  dispose() {
    this.#off?.()
    this.#off = undefined
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#watchers.clear()
    this.#turns.clear()
    this.#rings.clear()
  }

  /** Fold one raw frame into its session's pending text. */
  #accept(payload) {
    const record = payload
    const frame = record?.frame
    if (frame === undefined) return
    const sessionId = record?.agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return

    if (frame.type === 'end') {
      const turn = this.#turns.get(sessionId)
      // Flush BEFORE dropping the turn. The other order discarded whatever text
      // was still coalescing: `#flush` walks the map, so a turn removed from it
      // first had its final delta silently dropped — which is exactly the tail of
      // a reply, the part a listener would notice missing.
      this.#flush()
      this.#turns.delete(sessionId)
      this.#publish(sessionId, { type: 'end', sessionId, attemptId: turn?.attemptId ?? '' })
      return
    }

    const attemptId = typeof frame.attemptId === 'string' ? frame.attemptId : ''
    if (frame.type === 'start') {
      const step = intOr(frame.step, 0)
      // A start frame opens one STEP. The acting mark belongs to the step, not to
      // the turn: a turn with eight steps would otherwise report the first tool
      // call and never reset, so the browser would keep discarding text and only
      // ever speak the very last message.
      const previous = this.#turns.get(sessionId)
      const turn = previous !== undefined && previous.step === step && previous.attemptId === attemptId
        ? previous
        : new LiveTurn()
      turn.attemptId = attemptId
      turn.turn = intOr(frame.turn, 0)
      turn.step = step
      this.#turns.set(sessionId, turn)
      this.#flush()
      this.#publish(sessionId, {
        type: 'start',
        sessionId,
        attemptId,
        turn: turn.turn,
        step: turn.step,
      })
      return
    }

    if (frame.type !== 'chunk') return
    const turn = this.#turns.get(sessionId)
    if (turn === undefined || turn.attemptId !== attemptId) return
    const chunk = frame.chunk
    if (chunk === null || typeof chunk !== 'object') return

    if (chunk.type === 'text-delta') {
      if (typeof chunk.text !== 'string' || chunk.text === '') return
      turn.pending += chunk.text
      if (turn.pending.length > BUFFER_CAP) turn.pending = turn.pending.slice(-BUFFER_CAP)
      this.#schedule()
      return
    }

    // Anything else that is not reasoning means the model has moved on from
    // prose to acting — the text just streamed was a plan, not the answer.
    //
    // The type is matched by shape rather than by a fixed list: the exact chunk
    // names belong to the model provider and have changed between DSH releases,
    // and a wrong guess here would either keep the narration (this feature
    // failing silently) or drop the answer (a much worse failure). Reasoning
    // deltas are named explicitly because they are the one kind that legitimately
    // precedes prose and must NOT mark it as a plan.
    const kind = typeof chunk.type === 'string' ? chunk.type : ''
    if (kind === '' || kind.includes('reasoning')) return
    if (!/(tool|call|function|input|action)/u.test(kind)) return
    if (turn.acting) return
    turn.acting = true
    this.#flush()
    this.#publish(sessionId, { type: 'acting', sessionId, attemptId, kind })
  }

  /** Arm the coalescing timer once per batch. */
  #schedule() {
    if (this.#timer !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#flush()
    }, FLUSH_MS)
    this.#timer.unref?.()
  }

  /** Publish every session's pending text and clear it. */
  #flush() {
    for (const [sessionId, turn] of this.#turns) {
      if (turn.pending === '') continue
      const text = turn.pending
      turn.pending = ''
      turn.text = (turn.text + text).slice(-BUFFER_CAP)
      this.#publish(sessionId, { type: 'delta', sessionId, text, attemptId: turn.attemptId })
    }
  }

  /** Stamp one frame with its sequence number and fan it out. */
  #publish(sessionId, frame) {
    let ring = this.#rings.get(sessionId)
    if (ring === undefined) {
      ring = { seq: 0, frames: [] }
      this.#rings.set(sessionId, ring)
    }
    ring.seq += 1
    const stamped = { ...frame, seq: ring.seq }
    ring.frames.push(stamped)
    if (ring.frames.length > RING) ring.frames.splice(0, ring.frames.length - RING)
    this.#send(sessionId, stamped)
  }

  /** Deliver one frame to the session's watchers, ignoring a throwing socket. */
  #send(sessionId, frame) {
    const set = this.#watchers.get(sessionId)
    if (set === undefined) return
    for (const send of [...set]) {
      try {
        send(frame)
      } catch {
        set.delete(send)
      }
    }
  }
}

/** A finite integer, or the fallback. */
function intOr(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
}
