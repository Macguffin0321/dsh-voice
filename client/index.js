/**
 * `dsh-voice`, browser half.
 *
 * The page-side plugin body. It owns exactly one of each of the three live
 * objects — a {@link VoiceBridge} (host transport and live text),
 * a {@link Reader} (the audio timeline) and the `voice` facade the components
 * consume — then registers the two chat surfaces and the floating console.
 *
 * @module dsh-voice/client
 */

import { VoiceBridge } from './bridge.js'
import { Reader } from './speak.js'
import { VoiceConsole, shortVoice } from './ui.js'
import { registerMessageAction, registerSessionProbe } from './actions.js'
import { sanitizeSpeech, silentText } from './sanitize.js'
import { voiceLog } from './speak.js'
import { installStyles } from './styles.js'

/** Plugin name: matches the package name and the bundle row id. */
export const name = 'dsh-voice'

/** Services the browser half reads. */
export const inject = ['slots', 'sessions']

/** Where the console's saved position lives. */
const POSITION_KEY = 'dsh-voice.console-position'

/**
 * Announced when a reply leaves nothing to speak.
 *
 * Two routes reach it: the sanitized text was silent to begin with, or it
 * survived sanitizing but produced no segments (a reply that is only a code
 * block). Both mean the same thing to the user, so they say the same thing.
 */
const NOTHING_TO_READ = '这条回复还没有可朗读的文字'

/**
 * Locale prefixes the picker offers, in the order it shows them.
 *
 * The engines return every language they know — Edge alone ships 322 voices, and
 * all but a handful are unusable here. Only Chinese is kept: Mandarin (`zh-CN`,
 * which includes the regional `zh-CN-liaoning-` and `zh-CN-shaanxi-` voices),
 * Taiwanese Mandarin (`zh-TW`) and Cantonese (`zh-HK`).
 */
const VOICE_LOCALES = ['zh-CN', 'zh-TW', 'zh-HK']

/** The region subtag of a voice's locale: `zh-CN-liaoning` → `zh-CN`. */
function baseLocale(locale) {
  return String(locale ?? '').split('-').slice(0, 2).join('-')
}

/**
 * Whether a voice is a regional variant rather than the standard accent.
 *
 * Read from the id, never the locale: the host reports `zh-CN` for the Liaoning
 * and Shaanxi voices too, so the dialect shows up only in
 * `zh-CN-liaoning-XiaobeiNeural`.
 */
function isRegional(id, locale) {
  const head = String(id ?? '').split('-').slice(0, 2).join('-')
  return head !== '' && head === baseLocale(locale) && String(id ?? '').split('-').length > 3
}

/** A short Chinese label for one locale, or '' when it is not offered. */
function localeLabel(locale) {
  const value = baseLocale(locale)
  if (value === 'zh-CN') return '普通话'
  if (value === 'zh-TW') return '台湾'
  if (value === 'zh-HK') return '粤语'
  return ''
}

/**
 * Keep only the voices worth offering, grouped by language.
 *
 * Sorting here rather than relying on the engine's order because the engine
 * sorts by full locale string, which interleaves the groups: `zh-CN-liaoning-`
 * and `zh-CN-shaanxi-` sort before plain `zh-CN-`, so a list by locale alone
 * reads 粤语 → 台湾 → 粤语 → 普通话. Within a group the plain region comes first
 * (Xiaoxiao before the regional Xiaobei), then alphabetical.
 *
 * @param voices - the engine's full roster.
 * @returns the Chinese subset, ordered for the picker.
 */
function chineseVoices(voices) {
  const kept = voices.filter((item) => localeLabel(item?.locale) !== '')
  return kept.sort((left, right) => {
    const rank = VOICE_LOCALES.indexOf(baseLocale(left.locale)) - VOICE_LOCALES.indexOf(baseLocale(right.locale))
    if (rank !== 0) return rank
    // A plain region locale beats a regional variant, so the standard voices
    // (Xiaoxiao, Yunxi) come before the dialect ones (Liaoning, Shaanxi).
    const leftPlain = isRegional(left.id, left.locale) ? 1 : 0
    const rightPlain = isRegional(right.id, right.locale) ? 1 : 0
    if (leftPlain !== rightPlain) return leftPlain - rightPlain
    return String(left.label ?? '').localeCompare(String(right.label ?? ''))
  })
}

/**
 * {@link chineseVoices} memoised against the roster it was computed from.
 *
 * The console re-renders several times a second while a reply is being read, and
 * the picker asks for its rows on every one of them. The roster only changes
 * when voices are reloaded, so the sorted list and its labels are kept until
 * then. Identity comparison is enough: `loadVoices` assigns a fresh array each
 * time.
 */
const voiceCache = { source: null, rows: [], options: [] }

/** The sorted Chinese subset for one roster, computed once per roster. */
function cachedChineseVoices(voices) {
  if (voiceCache.source !== voices) {
    voiceCache.source = voices
    voiceCache.rows = chineseVoices(voices)
    voiceCache.options = []
  }
  return voiceCache.rows
}

/**
 * Browser plugin body.
 *
 * @param ctx - client root context.
 */
export function apply(ctx) {
  ctx.effect(() => installStyles(), 'dsh-voice: stylesheet')

  const bridge = new VoiceBridge({
    baseUrl: '',
    sessions: ctx.get('sessions'),
    onLive: (event) => { voice.handleLive(event) },
    onStatus: (patch) => { voice.publish('status', patch) },
    onError: (error) => { voice.reportError(error) },
  })

  /** True when the last turn stopped mid-sentence (see VoiceBridge). */
  let truncated = false
  const reader = new Reader({
    baseUrl: '',
    getSettings: () => bridge.settings,
    softChunkChars: 40,
    onUpdate: (snapshot) => { voice.publish('snapshot', snapshot) },
    onError: (error) => { voice.reportError(error) },
  })

  const listeners = { status: new Set(), voices: new Set(), snapshot: new Set() }
  /** The session whose conversation is on screen. */
  let currentSession = ''
  /** A short human note shown when nothing is being spoken. */
  let notice = ''
  /** Settings are read from here before the first host round-trip. */
  let position = readPosition()
  /** The last diagnostic report (see `voice.diagnose`). */
  let diagnosticText = ''
  /** Whether the previous pre-reading check found Edge unavailable. */
  let lastHealthWasDown = false

  const voice = {
    reader,
    bridge,
    /**
     * The HTTP base every facade method builds URLs from. It is a member here
     * (not read through `this` by accident) because the facade's methods run
     * with `this` bound to the facade, which has no engine state of its own.
     */
    baseUrl: '',
    get settings() {
      return reader === undefined ? bridge.settings : bridge.settings
    },
    get voices() {
      return cachedChineseVoices(bridge.voices)
    },

    /**
     * The full roster the engine reported, for the diagnostic report.
     *
     * The picker shows the Chinese subset; the report should still show how many
     * voices the engine actually returned, or a future "why is my voice missing"
     * question could not be answered from it.
     */
    get allVoiceCount() {
      return bridge.voices.length
    },
    get hostReady() {
      return bridge.hostReady
    },

    /** The last Edge connectivity answer, or null before the first check. */
    get health() {
      return bridge.health
    },

    /**
     * Check the Edge service and say what happened.
     *
     * This is the console's sync button. It forces a real probe, so it is also
     * the way to clear a stale failure: the host caches a failure for only a
     * short while, and this bypasses even that.
     *
     * @returns the health payload, or null when the host itself is unreachable.
     */
    async syncService() {
      voice.announce('正在检查 Edge 服务…')
      const health = await bridge.checkHealth({ force: true })
      if (health === null) {
        voice.announce('检查失败：无法连接到语音宿主')
        return null
      }
      if (health.reachable) {
        voice.announce(`Edge 服务正常（${String(health.ms)} ms）`)
        return health
      }
      voice.announce(`Edge 服务不可用：${health.message}`)
      return health
    },

    get announcedMessage() {
      return notice
    },

    /** True while the reading loop is switched on at all. */
    enabled() {
      return bridge.settings.enabled !== false
    },

    /**
     * What the last window-drag attempt did (see `dragTrace` in ui.js).
     *
     * @returns the trace object, or null before the first attempt.
     */
    dragTrace() {
      return globalThis.__DSH_VOICE_DRAG__ ?? null
    },

    /**
     * True when the last turn stopped mid-sentence.
     *
     * The model can be cut off by a token limit, and what it did produce is
     * spoken. Without this flag the listener cannot tell that apart from audio
     * they missed — the two sound identical.
     */
    truncated() {
      return truncated
    },

    /** Subscribe to one channel; returns the unsubscribe function. */
    on(channel, listener) {
      const set = listeners[channel] ?? listeners.status
      set.add(listener)
      return () => { set.delete(listener) }
    },

    /** Fan one payload out to a channel. */
    publish(channel, payload) {
      if (channel === 'snapshot') announceFrom(snapshotMessage(payload))
      if (channel === 'status' && payload?.settings !== undefined) {
        reader.softChunkChars = numberOr(payload.settings.softChunkChars, reader.softChunkChars)
        reader.maxCharsPerRequest = numberOr(payload.settings.maxCharsPerRequest, reader.maxCharsPerRequest)
        if (reader.rateOverride === null) reader.rateOverride = null
      }
      for (const listener of [...(listeners[channel] ?? [])]) {
        try {
          listener(payload)
        } catch { /* a throwing listener never affects the engine */ }
      }
    },

    /** Record a failure for the console instead of throwing at the UI. */
    reportError(error) {
      const message = error instanceof Error ? error.message : String(error)
      notice = `语音出错：${message}`
      voice.publish('status', { error: message })
    },

    /** Show a short note in the console's now-line. */
    announce(text) {
      notice = text
      voice.publish('status', { notice: text })
    },

    /** Persisted console position. */
    position() {
      return position
    },

    /** Persist the console position. */
    savePosition(next) {
      position = next
      try {
        globalThis.localStorage?.setItem(POSITION_KEY, JSON.stringify(next))
      } catch { /* a locked-down storage is not an error */ }
    },

    /** The label for the "engine default" option. */
    defaultVoiceLabel() {
      const resolved = bridge.resolved === '' ? bridge.settings.engine : bridge.resolved
      if (resolved === 'edge') return '默认（晓晓 zh-CN-XiaoxiaoNeural）'
      if (resolved === 'local') return '默认（系统音色）'
      return '默认'
    },

    /**
     * The voice picker's rows, with a heading where the language changes.
     *
     * The heading is a separate entry rather than a field on the voice, because
     * the picker has to render it as its own disabled row.
     *
     * @returns `{ voice, label, heading }[]`; `heading` is null except on the
     *   first voice of each language.
     */
    voiceOptions() {
      // Resolving the rows first is what validates the cache against the current
      // roster. Returning `voiceCache.options` before that call would serve the
      // previous roster's rows for ever, because the invalidation lives inside
      // `cachedChineseVoices`.
      const rows = cachedChineseVoices(bridge.voices)
      if (voiceCache.options.length > 0) return voiceCache.options
      let previous = ''
      voiceCache.options = rows.map((item) => {
        const family = localeLabel(item?.locale)
        const heading = family === previous ? null : family
        previous = family
        const name = String(item?.label ?? item?.id ?? '')
        const gender = item?.gender === 'Female' ? '女' : item?.gender === 'Male' ? '男' : ''
        return {
          voice: item,
          heading,
          label: [name, gender].filter((part) => part !== '').join(' · '),
        }
      })
      return voiceCache.options
    },

    /**
     * A warning when the saved voice does not belong to the resolved engine.
     *
     * Edge ids (`zh-CN-XiaoxiaoNeural`) and OS voice names (`Tingting`) are
     * different vocabularies, and a mismatched pair is exactly how a system
     * speech command ends up speaking with its default voice while the UI shows
     * the chosen one.
     *
     * @returns the warning, or '' when the pair is consistent.
     */
    voiceMismatch() {
      const configured = bridge.settings.voice
      if (configured === '') return ''
      const resolved = bridge.resolved === '' ? bridge.settings.engine : bridge.resolved
      if (resolved !== 'local') return ''
      if (bridge.voices.length === 0) return ''
      if (bridge.voices.some((item) => item.id === configured)) return ''
      return `当前引擎是系统语音，但保存的音色「${configured}」是 Edge 音色名，系统语音不认识它 —— 会在下一条生效为默认音色。请在音色列表里选一个系统音色，或把 cordis.patch.yml 里的 engine 改成 edge。`
    },

    /** The session the open conversation belongs to. */
    setCurrentSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      currentSession = sessionId
      if (voice.enabled()) bridge.focus(sessionId)
    },

    /** Forget a session that is no longer on screen. */
    releaseCurrentSession(sessionId) {
      if (currentSession !== sessionId) return
      currentSession = ''
    },

    /**
     * Toggle the reading of one message.
     *
     * Pressing while that message is playing stops it; otherwise the message's
     * settled text (or, for a turn still streaming, its text so far) starts
     * from the beginning.
     */
    async toggleMessage({ sessionId, messageId, turn }) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      currentSession = sessionId
      // A press always re-focuses the live transport on this session.
      bridge.focus(sessionId)
      const mine = reader.current?.sessionId === sessionId
      const speaking = mine && (reader.playing || reader.phase === 'buffering')
      const sameMessage = reader.current?.reason === 'replay' && reader.current?.turn === (typeof turn === 'number' ? turn : null)
      if (speaking && sameMessage) {
        reader.reset()
        voice.announce('已停止朗读')
        return
      }
      let text = typeof messageId === 'string' && messageId !== '' ? bridge.messageText(sessionId, messageId) : ''
      if (text === '' && typeof turn === 'number') text = bridge.turnText(sessionId, turn)
      if (text === '') {
        // The turn is still streaming: read what has arrived so far.
        text = bridge.readers.get(sessionId)?.streamed ?? ''
      }
      const clean = sanitizeSpeech(text)
      if (silentText(clean)) {
        voice.announce(NOTHING_TO_READ)
        return
      }
      try {
        const count = await reader.playText(clean, { sessionId, turn: typeof turn === 'number' ? turn : null })
        if (count > 0) voice.announce(`正在朗读（${String(count)} 句）`)
        // The text was not silent, yet it produced no segments: sanitizing left
        // nothing speakable (a reply that is only a code block, say).
        else voice.announce(NOTHING_TO_READ)
      } catch (error) {
        voice.announce(`朗读失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },

    /**
     * Whether there is anything for the console's re-read button to read.
     *
     * The speaker button answers the same question for its own message; the
     * console has no message id, so it asks about the current turn: text already
     * streamed, or a settled message on the visible session.
     *
     * @returns true when re-reading would produce something.
     */
    canReread() {
      if (reader.segments.length > 0) return true
      // The same sources, in the same order, that `reread()` walks.
      const current = reader.current
      const sessionId = current?.sessionId ?? currentSession
      if (typeof sessionId === 'string' && sessionId !== '') {
        if (current?.turn !== null && current?.turn !== undefined && bridge.turnText(sessionId, current.turn) !== '') return true
        if (typeof current?.messageId === 'string' && bridge.messageText(sessionId, current.messageId) !== '') return true
        if ((bridge.readers.get(sessionId)?.streamed ?? '') !== '') return true
      }
      return !silentText(sanitizeSpeech(reader.replayText))
    },

    /**
     * Re-read whatever is on screen right now with the current voice.
     *
     * It prefers the settled message's own text (so the reading is complete and
     * properly sanitized) and falls back to the text the current reading was
     * built from — which is what a live reply has.
     */
    async reread() {
      const current = reader.current
      const sessionId = current?.sessionId ?? currentSession
      let text = ''
      if (typeof sessionId === 'string' && sessionId !== '') {
        if (current?.turn !== null && current?.turn !== undefined) text = bridge.turnText(sessionId, current.turn)
        if (text === '' && typeof current?.messageId === 'string') text = bridge.messageText(sessionId, current.messageId)
      }
      if (text === '') text = reader.replayText
      const clean = sanitizeSpeech(text)
      if (silentText(clean)) {
        voice.announce('没有可重读的文字')
        return
      }
      await reader.playText(clean, {
        sessionId: typeof sessionId === 'string' ? sessionId : '',
        turn: typeof current?.turn === 'number' ? current.turn : null,
      })
    },

    /**
     * Play a fixed sample sentence in the currently configured voice on its own
     * fresh player.
     *
     * This is the one-press answer to "did the voice actually change": it uses
     * no shared player, no cached segment and no reading state, so the sound it
     * makes is exactly what the host produced for the selected voice. If the
     * sample changes when the voice changes, synthesis and delivery are fine
     * and any remaining problem is in the reading player; if the sample does not
     * change, the bytes never differed.
     *
     * @param voiceId - voice to sample; defaults to the configured one.
     * @returns `{ ok, detail }`.
     */
    async sampleVoice(voiceId) {
      const wanted = typeof voiceId === 'string' ? voiceId : bridge.settings.voice
      const text = '音色测试：这是当前选中的声音。'
      try {
        voiceLog.add('sample', `POST /voice/segment voice=${wanted === '' ? '(默认)' : wanted} engine=${bridge.settings.engine}`)
        let response
        try {
          response = await fetch(`${bridge.baseUrl}/voice/segment?t=${String(Date.now())}`, {
            method: 'POST',
            // A synthesis answer is a function of the request body, so a cached
            // response would replay one voice's audio for every later request.
            cache: 'no-store',
            // `text/plain` keeps this a CORS "simple request": a JSON content
            // type would trigger a preflight that the desktop shell's
            // cross-origin page cannot complete. The host parses the body
            // regardless of the declared type.
            headers: { 'content-type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify({ text, voice: wanted, engine: bridge.settings.engine }),
          })
        } catch (error) {
          const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          voiceLog.add('sample', `传输失败：${detail}`)
          voice.announce(`试听失败（网络）：${detail}`)
          return { ok: false, detail }
        }
        voiceLog.add('sample', `HTTP ${String(response.status)} spoke=${response.headers.get('x-voice-voice') ?? '-'}`)
        if (!response.ok) {
          let message = `HTTP ${String(response.status)}`
          try {
            const parsed = JSON.parse(await response.text())
            if (typeof parsed?.error === 'string') message = parsed.error
          } catch { /* a non-JSON error body keeps the status */ }
          voice.announce(`试听失败：${message}`)
          return { ok: false, detail: message }
        }
        const blob = await response.blob()
        const spoke = decodeURIComponent(response.headers.get('x-voice-voice') ?? '')
        const url = URL.createObjectURL(blob)
        const probe = new Audio()
        probe.volume = 1
        probe.src = url
        const outcome = await new Promise((resolve) => {
          const timer = setTimeout(() => { resolve('超时') }, 12000)
          probe.addEventListener('ended', () => { clearTimeout(timer); resolve('ok') }, { once: true })
          probe.addEventListener('error', () => { clearTimeout(timer); resolve(`播放失败 code=${String(probe.error?.code ?? '?')}`) }, { once: true })
          probe.play().catch((error) => { clearTimeout(timer); resolve(`播放被拒：${error?.name ?? 'error'}`) })
        })
        voiceLog.add('sample', `结果=${outcome} bytes=${String(blob.size)} duration=${String(probe.duration)} readyState=${String(probe.readyState)} networkState=${String(probe.networkState)}`)
        setTimeout(() => { URL.revokeObjectURL(url) }, 15000)
        const label = spoke === '' ? (wanted === '' ? voice.defaultVoiceLabel() : shortVoice(wanted)) : shortVoice(spoke)
        voice.announce(outcome === 'ok' ? `试听完成：${label}（${String(blob.size)} 字节）` : `试听${outcome}：${label}`)
        return { ok: outcome === 'ok', detail: `${label} / ${String(blob.size)} bytes / ${outcome}` }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        voice.announce(`试听失败：${message}`)
        return { ok: false, detail: message }
      }
    },

    /**
     * Build the diagnostic report and put it on the clipboard.
     *
     * The desktop client has no developer console, so the report has to leave
     * the app by itself: it is copied to the clipboard (and also printed to the
     * console for anyone who does have one) and the console surface says so.
     *
     * @returns the report text.
     */
    async diagnose() {
      const snapshot = reader.snapshot()
      const lines = [
        '=== dsh-voice 诊断报告 ===',
        `时间：${new Date().toISOString()}`,
        `页面来源：${globalThis.location?.href ?? '?'}`,
        `宿主就绪：${String(bridge.hostReady)}  引擎：${bridge.resolved || bridge.settings.engine}  配置音色：${bridge.settings.voice === '' ? '(默认)' : bridge.settings.voice}`,
        `朗读覆盖音色：${String(snapshot.voiceOverride ?? '(无)')}  当前段音色：${snapshot.voice === '' ? '(未知)' : snapshot.voice}`,
        `阶段：${snapshot.phase}  播放中：${String(snapshot.playing)}  段数：${String(snapshot.size)}  就绪：${String(snapshot.ready)}  待合成：${String(snapshot.pending)}  失败：${String(snapshot.errors)}`,
        `本轮是否被截断：${truncated ? '是（模型没写完，不是朗读漏了）' : '否'}`,
        `窗口拖动：${(() => { const t = globalThis.__DSH_VOICE_DRAG__; if (t?.down === null || t?.down === undefined) return '(还没试过)'; const skip = t.down.skipped === undefined ? '' : ` 跳过原因=${t.down.skipped}`; return `按在 ${String(t.down.target)}${skip}  收到移动=${String(t.moves)} 次  最后=${t.last === null ? '(无)' : `位移(${String(t.last.dx)},${String(t.last.dy)}) → left=${String(t.last.left)} top=${String(t.last.top)} 视口=${String(t.last.viewport)}`}`; })()}`,
        `朗读结尾：${reader.segments.length === 0 ? '(无)' : `[最后一段] ${reader.segments[reader.segments.length - 1].text.slice(-40)}`}`,
        `原始结尾：${(bridge.reader?.(bridge.focusSession)?.raw ?? '').trim().slice(-40) || '(无)'}`,
        `媒体元素：src=${reader.audio?.src === '' ? '(空)' : 'blob'} paused=${String(reader.audio?.paused)} currentTime=${String(reader.audio?.currentTime ?? '?')} networkState=${String(reader.audio?.networkState ?? '?')} readyState=${String(reader.audio?.readyState ?? '?')}`,
        `音色列表：可选 ${String(voice.voices.length)} 项 / 引擎共 ${String(bridge.voices.length)} 项（来源引擎 ${bridge.voicesEngine || '?'}）`,
        `实时通道：${bridge.polling ? '轮询' : 'WebSocket'}  跟随会话：${bridge.focusSession || '(无)'}`,
        '',
        '--- 最近合成往返 ---',
        ...snapshot.requests.map((item) => `#${String(item.index)} asked=${item.asked === '' ? '(默认)' : item.asked} spoke=${item.spoke === '' ? '(空)' : item.spoke} bytes=${String(item.bytes ?? '?')} fp=${item.fingerprint ?? ''} cached=${String(item.cached)}${item.error === '' ? '' : ` ERR=${item.error}`}${item.notice === undefined || item.notice === '' ? '' : ` NOTICE=${item.notice}`}`),
        '',
        '--- 流水线日志 ---',
        voiceLog.text(),
      ]
      const text = lines.join('\n')
      let copied = false
      try {
        await globalThis.navigator?.clipboard?.writeText?.(text)
        copied = true
      } catch { /* the clipboard may be unavailable; the notice still says where to look */ }
      try {
        globalThis.console?.info?.(text)
      } catch { /* a locked-down console is fine */ }
      voice.announce(copied ? '诊断报告已复制到剪贴板，直接粘贴给我即可' : '诊断报告已打印到开发者控制台')
      diagnosticText = text
      return text
    },

    /** The last report, kept on the facade for a console-only reader. */
    get lastDiagnostic() {
      return diagnosticText
    },

    /** Fold a live transport event into the reading. */
    handleLive(event) {
      if (!voice.enabled() || bridge.settings.autoRead !== true) return
      if (event.kind === 'start') {
        if (event.sessionId !== currentSession) return
        // A new turn supersedes whatever the previous one was reading.
        if (reader.segments.length > 0 && reader.current?.reason !== 'replay') reader.reset()
        truncated = false
        // Every reply begins by asking whether the Edge service is actually
        // answering. The host caches the probe, so this costs nothing most of the
        // time; when it does fail the user is told before a silent reading rather
        // than after one.
        void checkBeforeReading()
        return
      }
      if (event.kind === 'segments') {
        if (event.sessionId !== currentSession) return
        const created = reader.enqueue(event.segments, {
          sessionId: event.sessionId,
          turn: event.turn,
          reason: event.reason,
        })
        if (created.length > 0 && !reader.playing && reader.phase !== 'buffering') void reader.play()
        return
      }
      if (event.kind === 'end') {
        if (event.sessionId !== currentSession) return
        // A turn that stopped mid-sentence is reported, not hidden: the listener
        // otherwise cannot tell a truncated reply from audio they missed.
        truncated = event.truncated === true
        reader.end()
        return
      }
      if (event.kind === 'settle') {
        if (event.sessionId !== currentSession) return
        reader.enqueue(event.segments, { sessionId: event.sessionId, turn: event.turn, reason: event.reason })
        if (!reader.playing) void reader.play()
      }
    },

    /** Change the speaking voice and persist it. */
    async setVoice(voiceId) {
      bridge.settings = { ...bridge.settings, voice: voiceId }
      voice.publish('status', { settings: bridge.settings })
      // `setVoice` re-queues whatever is being read, so a switch is audible
      // immediately instead of only on the next reply.
      const revoiced = reader.setVoice(voiceId)
      const label = voiceId === '' ? voice.defaultVoiceLabel() : shortVoice(voiceId)
      voice.announce(revoiced ? `已换成 ${label}，正在用新音色重读` : `已换成 ${label}，下一条回复生效`)
      await bridge.updateSettings({ voice: voiceId })
    },

    /**
     * Change the speaking rate and persist it.
     *
     * The UI works in multipliers (`0.5x` … `2x`); the host works in a
     * percentage offset for the neural and OS voices and in an absolute rate for
     * the page voice. Both are derived from the multiplier here.
     *
     * @param multiplier - `0.5` … `2`.
     * @returns the applied rate.
     */
    async setRateMultiplier(multiplier) {
      const value = clampMultiplier(multiplier)
      // Speed is a property of LISTENING, not of synthesis: the host always
      // produces natural-pace audio (its neural service caps its own speed-up)
      // and the player scales it, which keeps the pitch and makes the change
      // instant with no re-synthesis.
      const live = reader.segments.length > 0
      reader.setRate(value)
      voice.publish('status', { settings: bridge.settings })
      voice.announce(live
        ? `已切到 ${formatMultiplier(value)} 倍速（立即生效，无需重新合成）`
        : `已切到 ${formatMultiplier(value)} 倍速，下一条回复生效`)
      return value
    },

    /** The multiplier the UI should show as selected. */
    currentMultiplier() {
      return reader.rateMultiplier > 0 ? reader.rateMultiplier : 1
    },

    /** Turn automatic reading of new replies on or off. */
    async setAutoRead(enabled) {
      bridge.settings = { ...bridge.settings, autoRead: enabled === true }
      voice.publish('status', { settings: bridge.settings })
      if (enabled === true && currentSession !== '') bridge.focus(currentSession)
      await bridge.updateSettings({ autoRead: enabled === true })
    },

    /** Reload the roster for the configured engine. */
    async reloadVoices() {
      await bridge.loadVoices(bridge.settings.engine)
    },

    /** First-run wiring: read the host snapshot and the voice roster. */
    async start() {
      const ok = await bridge.refresh()
      if (ok && bridge.settings.enabled !== false) {
        await bridge.loadVoices(bridge.settings.engine)
        if (currentSession !== '') bridge.focus(currentSession)
      }
      voice.publish('status', { settings: bridge.settings, ready: ok })
    },
  }

  /** Update the console's fallback line when the reading goes idle. */
  function announceFrom(message) {
    if (message !== '') notice = message
  }

  /**
   * Check the Edge service before a reading, and speak up only when it matters.
   *
   * Called at the start of every turn. The host caches the probe, so the common
   * case is one cheap request; the announcement is made only when the answer
   * CHANGES, because a line repeated on every reply would be noise rather than
   * information.
   */
  async function checkBeforeReading() {
    if (bridge.settings.engine !== 'auto') return
    const health = await bridge.checkHealth()
    if (health === null) return
    if (health.reachable) {
      if (lastHealthWasDown) voice.announce('Edge 服务已恢复')
      lastHealthWasDown = false
      return
    }
    if (!lastHealthWasDown) voice.announce(`Edge 服务不可用：${health.message}`)
    lastHealthWasDown = true
  }

  ctx.effect(() => () => {
    bridge.dispose()
    reader.dispose()
    try {
      delete globalThis.__DSH_VOICE__
    } catch { /* a frozen global keeps the last reference */ }
  }, 'dsh-voice: lifetime')

  // Debug handle: the engine, the bridge and the facade on the page global so
  // a broken reading can be inspected from the browser console. It carries no
  // credentials and nothing else reads it.
  try {
    globalThis.__DSH_VOICE__ = { voice, reader, bridge }
  } catch { /* a frozen global is not an error */ }

  registerMessageAction(ctx, voice)
  registerSessionProbe(ctx, voice)

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'voice-console',
    order: 60,
    inject: () => ({ voice }),
  }, VoiceConsole))

  void voice.start()
}

/** A short status line for an idle console. */
function snapshotMessage(snapshot) {
  if (snapshot.phase === 'paused' && snapshot.size > 0) return '已暂停'
  if (snapshot.finished && snapshot.size > 0) return '已读完'
  return ''
}

/** Read the saved console position. */
function readPosition() {
  try {
    const raw = globalThis.localStorage?.getItem(POSITION_KEY)
    if (typeof raw !== 'string' || raw === '') return { right: '24px', bottom: '96px' }
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return { right: '24px', bottom: '96px' }
    return parsed
  } catch {
    return { right: '24px', bottom: '96px' }
  }
}

/** The selectable speed multipliers. */
export const RATE_CHOICES = [0.5, 0.75, 1, 1.5, 2]

/** Clamp one multiplier onto the supported ladder. */
function clampMultiplier(value) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 1
  let best = RATE_CHOICES[0]
  for (const choice of RATE_CHOICES) {
    if (Math.abs(choice - numeric) < Math.abs(best - numeric)) best = choice
  }
  return best
}

/** Render one multiplier for the UI. */
function formatMultiplier(value) {
  return Number.isInteger(value) ? String(value) : String(value)
}

/** A finite number, or the fallback. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
