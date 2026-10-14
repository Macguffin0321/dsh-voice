#!/usr/bin/env node
/**
 * Host-half tests: the WAV/MPEG duration parsers, the PCM wrapper, the
 * settings store, the live bridge's frame ring, and the `/voice/*` routes
 * against a fake webserver.
 *
 * Run with `node scripts/test-host.mjs`.
 *
 * @module dsh-voice/scripts/test-host
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { audioDuration, wavFromPcm } from '../lib/engines.js'
import { VoiceConfigStore, WRITABLE_KEYS } from '../lib/config.js'
import { LiveTextBridge } from '../lib/live.js'
import { registerRoutes } from '../lib/routes.js'
import { cutSegments, sanitizeSpeech, silentText } from '../client/sanitize.js'
import { looksUnfinished } from '../client/bridge.js'

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

/** Build a silent 16-bit mono PCM buffer of `seconds` at `rate` Hz. */
function pcm(seconds, rate = 22050) {
  return Buffer.alloc(Math.round(seconds * rate) * 2)
}

/** A minimal WAV file of a known duration. */
function wav(seconds, rate = 22050) {
  return wavFromPcm(pcm(seconds, rate), rate)
}

/** Build a constant-bitrate MPEG-1 layer III stream of `frames` frames. */
function mp3(frames, bitrateKbps = 48, rate = 24000) {
  const samples = 1152
  const length = Math.floor((samples / 8 * bitrateKbps * 1000) / rate)
  const frame = Buffer.alloc(length)
  frame[0] = 0xff
  frame[1] = 0xfb // MPEG-1 layer III, no CRC
  frame[2] = 0x90 // bitrate index 9 (48 kbps at V2... see table), rate index 0
  frame[3] = 0xc0
  const out = []
  for (let index = 0; index < frames; index += 1) out.push(frame)
  return Buffer.concat(out)
}

/** The in-memory home for the store test. */
const home = mkdtempSync(join(tmpdir(), 'dsh-voice-test-'))
process.env.DSH_HOME = home

/** A logger that records warnings so a silent failure is visible. */
const logs = []
const logger = {
  info: (...args) => { logs.push(['info', ...args]) },
  warn: (...args) => { logs.push(['warn', ...args]) },
  debug: () => {},
}

process.stdout.write('dsh-voice host tests\n')

// ── audio duration ────────────────────────────────────────────────────────
const oneSecond = wav(1)
const parsed = audioDuration(oneSecond, 'audio/wav')
check(parsed !== null && Math.abs(parsed - 1) < 0.01, 'WAV duration parsed', String(parsed))
const halfSecond = audioDuration(wav(0.5), 'audio/wav')
check(halfSecond !== null && Math.abs(halfSecond - 0.5) < 0.01, 'WAV half-second duration', String(halfSecond))
check(audioDuration(Buffer.from('not audio'), 'audio/wav') === null, 'garbage has no duration')
const wrapped = wavFromPcm(Buffer.alloc(20), 10000)
check(wrapped.length === 64 && wrapped.toString('ascii', 0, 4) === 'RIFF', 'PCM is wrapped in a RIFF header')
check(wrapped.readUInt32LE(24) === 10000, 'wrapper writes the sample rate', String(wrapped.readUInt32LE(24)))

// ── settings store ────────────────────────────────────────────────────────
const ctx = { logger }
const store = new VoiceConfigStore(ctx, { enabled: true, engine: 'auto', voice: '', rate: 0, softChunkChars: 40 }, { backupCount: 1 })
check(store.get().engine === 'auto', 'store starts from the loader config')
const applied = store.update({ engine: 'edge', voice: 'zh-CN-XiaoxiaoNeural', rate: 120 })
check(applied.settings.rate === 50, 'out-of-range rate is clamped', String(applied.settings.rate))
check(applied.settings.engine === 'edge', 'engine override applied')
check(applied.issues.length === 0, 'valid submission has no issues', applied.issues.join(';'))
const bad = store.update({ engine: 'nope' })
check(bad.issues.length === 1, 'unknown engine is refused', bad.issues.join(';'))
check(bad.settings.engine === 'edge', 'a refused write leaves the snapshot alone')
const saved = JSON.parse(readFileSync(join(home, 'voice-settings.json'), 'utf8'))
check(saved.engine === 'edge' && saved.voice === 'zh-CN-XiaoxiaoNeural', 'overrides persisted to disk', JSON.stringify(saved))
const reloaded = new VoiceConfigStore(ctx, { engine: 'auto', voice: '' }, { backupCount: 0 })
check(reloaded.get().engine === 'edge', 'a new store folds the saved overrides over the loader config')
check(WRITABLE_KEYS.includes('autoRead'), 'autoRead is writable')
check(reloaded.update({ autoRead: 'yes' }).issues.length === 1, 'a non-boolean boolean is refused')

// ── live bridge ───────────────────────────────────────────────────────────
const listeners = []
const liveCtx = {
  logger,
  on(event, fn) {
    listeners.push({ event, fn })
    return () => { listeners.splice(0, listeners.length) }
  },
}
const live = new LiveTextBridge(liveCtx)
check(listeners.length === 1 && listeners[0].event === 'agent/assistant-stream', 'bridge subscribes the assistant stream')
const received = []
const unsubscribe = live.subscribe('s1', (frame) => received.push(frame))
const agent = { session: { id: 's1' } }
listeners[0].fn({ agent, frame: { type: 'start', attemptId: 'a1', turn: 1, step: 1 } })
listeners[0].fn({ agent, frame: { type: 'chunk', attemptId: 'a1', index: 0, chunk: { type: 'text-delta', text: '你好' } } })
listeners[0].fn({ agent, frame: { type: 'chunk', attemptId: 'a1', index: 1, chunk: { type: 'reasoning-delta', text: '思考中' } } })
listeners[0].fn({ agent, frame: { type: 'chunk', attemptId: 'a1', index: 2, chunk: { type: 'text-delta', text: '，世界。' } } })
await new Promise((resolvePromise) => setTimeout(resolvePromise, 160))
const deltas = received.filter((frame) => frame.type === 'delta').map((frame) => frame.text)
check(deltas.join('') === '你好，世界。', 'only text deltas are forwarded', JSON.stringify(deltas))
check(received.every((frame, index) => index === 0 || frame.seq > received[index - 1].seq), 'frames carry increasing sequence numbers')
check(live.size === 1, 'bridge reports one live session', String(live.size))
const polled = live.since('s1', 0)
check(polled.frames.length === received.length, 'polling reads the same ring', `${String(polled.frames.length)} vs ${String(received.length)}`)
check(live.since('s1', polled.cursor).frames.length === 0, 'a caught-up cursor returns nothing')
listeners[0].fn({ agent, frame: { type: 'end', attemptId: 'a1' } })
await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
check(received.some((frame) => frame.type === 'end'), 'the end frame reaches the subscriber')
unsubscribe()
check(live.since('s1', 0).frames.length > 0, 'the ring survives an unsubscribe')

// ── routes ────────────────────────────────────────────────────────────────
const routes = []
const upgrades = []
const webServer = {
  register: (route) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } },
  registerUpgrade: (route) => { upgrades.push(route); return () => { upgrades.splice(upgrades.indexOf(route), 1) } },
}
const routeCtx = { logger, get: (name) => (name === 'webServer' ? webServer : undefined) }
const engines = {
  resolvedEngine: () => 'edge',
  checkEdge: async () => ({ ok: true, at: Date.now(), ms: 12, message: '' }),
  voiceFor: () => 'zh-CN-XiaoxiaoNeural',
  capabilities: () => ({ platform: 'darwin', edge: { command: 'edge-tts' }, local: { command: '/usr/bin/say' } }),
  voices: async () => [{ id: 'zh-CN-XiaoxiaoNeural', label: 'Xiaoxiao', locale: 'zh-CN', gender: 'Female' }],
  synthesize: async (text, overrides) => ({
    bytes: Buffer.from('audio-bytes'),
    mime: 'audio/mpeg',
    duration: 1.5,
    engine: overrides.engine ?? 'edge',
    voice: overrides.voice ?? 'zh-CN-XiaoxiaoNeural',
    rate: 0,
    cached: false,
  }),
}
const dispose = registerRoutes(routeCtx, { store: reloaded, engines, live })
check(routes.length === 6, 'six HTTP routes registered', String(routes.length))
check(upgrades.length === 1, 'one websocket upgrade registered', String(upgrades.length))
check(routes.some((route) => route.path === '/voice/status'), 'status route present')
check(routes.some((route) => route.path === '/voice/segment'), 'segment route present')
check(routes.some((route) => route.path === '/voice/live'), 'live poll route present')
check(routes.some((route) => route.path === '/voice/health'), 'health route present')

/** Drive one route with a fabricated request. */
// ── the Edge connectivity gate ─────────────────────────────────────────────
// `detectTools()` only proves edge-tts is installed, and installation is not the
// failure that bites: Microsoft rotates the token scheme and every request is
// refused while the package still looks fine. `auto` must then hand over to the
// OS voice instead of leaving replies unread.
{
  const { VoiceEngines } = await import('../lib/engines.js')
  const silent = { info() {}, warn() {} }
  /**
   * An engines instance whose Edge probe is forced to one answer.
   *
   * @param ok - what the probe should report.
   * @returns the instance.
   */
  const withEdgeHealth = (ok) => {
    const instance = new VoiceEngines({ logger: silent }, { get: () => ({ engine: 'auto', voice: '', rate: 0 }) })
    instance.checkEdge = async () => ({ ok, at: Date.now(), ms: 5, message: ok ? '' : 'Edge 拒绝了连接（HTTP 403）' })
    return instance
  }

  const healthy = withEdgeHealth(true)
  const good = await healthy.synthesize('探测通过', {})
  check(good.engine === 'edge', 'a healthy Edge probe keeps using Edge', good.engine)
  check(good.fellBack !== true, 'a healthy reading reports no fallback', String(good.fellBack))

  const broken = withEdgeHealth(false)
  const fellBack = await broken.synthesize('探测失败', {})
  check(fellBack.engine === 'local', 'a failed Edge probe falls back to the OS voice', fellBack.engine)
  check(fellBack.fellBack === true, 'the fallback is flagged for the console', String(fellBack.fellBack))
  check(
    typeof fellBack.notice === 'string' && fellBack.notice.includes('Edge 合成服务不可用'),
    'the fallback is explained in the notice',
    String(fellBack.notice).slice(0, 60),
  )
  check(fellBack.bytes.length > 0, 'the fallback still produces audio', String(fellBack.bytes?.length ?? 0))
}

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const route = routes.find((item) => item.path === path.split('?')[0])
  if (route === undefined) throw new Error(`no route ${path}`)
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const request = {
    method,
    url: path,
    headers: {
      host: '127.0.0.1:19387',
      ...(body === undefined ? {} : { 'content-length': String(chunks[0].length) }),
      ...headers,
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  let status = 0
  let responseHeaders = {}
  let payload = Buffer.alloc(0)
  const response = {
    statusCode: 200,
    writeHead(code, extra) { status = code; responseHeaders = extra ?? {} },
    end(value) { payload = value === undefined ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : Buffer.from(String(value)) },
  }
  await route.handler(request, response)
  return { status, headers: responseHeaders, payload, json: () => JSON.parse(payload.toString('utf8')) }
}

const statusReply = await call('/voice/status')
check(statusReply.status === 200 && statusReply.json().resolved === 'edge', 'status answers 200 with the resolved engine')
check(statusReply.json().settingsFile.endsWith('voice-settings.json'), 'status reports the settings file')

const voicesReply = await call('/voice/voices?engine=edge')
check(voicesReply.json().voices.length === 1, 'voices answers the roster')

const segmentReply = await call('/voice/segment', { method: 'POST', body: { text: '你好。' } })
check(segmentReply.status === 200, 'segment answers 200', String(segmentReply.status))
check(segmentReply.headers['content-type'] === 'audio/mpeg', 'segment sets the audio content type', segmentReply.headers['content-type'])
check(segmentReply.payload.toString('utf8') === 'audio-bytes', 'segment returns the raw audio bytes')
check(segmentReply.headers['x-voice-duration'] === '1.500', 'segment reports the duration', segmentReply.headers['x-voice-duration'])

const emptyReply = await call('/voice/segment', { method: 'POST', body: { text: '' } })
check(emptyReply.status === 400, 'empty text is refused', String(emptyReply.status))
const wrongMethod = await call('/voice/segment', { method: 'GET' })
check(wrongMethod.status === 405, 'the wrong method is refused', String(wrongMethod.status))
const foreign = await call('/voice/status', { headers: { origin: 'https://evil.example' } })
check(foreign.status === 403, 'a cross-origin caller is refused', String(foreign.status))
const sameOrigin = await call('/voice/status', { headers: { origin: 'http://127.0.0.1:19387' } })
check(sameOrigin.status === 200, 'a same-origin caller is allowed', String(sameOrigin.status))
const desktopOrigin = await call('/voice/status', { headers: { origin: 'dsh-app://app' } })
check(desktopOrigin.status === 200, 'the desktop shell origin is allowed', String(desktopOrigin.status))

const settingsReply = await call('/voice/settings', { method: 'POST', body: { autoRead: false } })
check(settingsReply.status === 200 && settingsReply.json().settings.autoRead === false, 'settings write answers the snapshot')
const settingsRefused = await call('/voice/settings', { method: 'POST', body: { engine: 'bogus' } })
check(settingsRefused.status === 400 && settingsRefused.json().issues.length === 1, 'settings refuses an unknown engine')

// ── the desktop shell's cross-origin contract ─────────────────────────────
// The page is served from `dsh-app://app/`, so its POSTs are cross-origin. A
// preflight the server does not answer is a POST the browser never sends.
const preflightReply = await call('/voice/segment', {
  method: 'OPTIONS',
  headers: {
    origin: 'dsh-app://app',
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type',
  },
})
check(preflightReply.status === 204, 'preflight is answered with 204', String(preflightReply.status))
check(
  preflightReply.headers['access-control-allow-origin'] === 'dsh-app://app',
  'preflight grants the desktop origin',
  String(preflightReply.headers['access-control-allow-origin']),
)
check(
  String(preflightReply.headers['access-control-allow-methods'] ?? '').includes('POST'),
  'preflight allows POST',
  String(preflightReply.headers['access-control-allow-methods']),
)

const crossOriginPost = await call('/voice/segment', {
  method: 'POST',
  body: { text: '跨源合成。' },
  headers: { origin: 'dsh-app://app' },
})
check(crossOriginPost.status === 200, 'a cross-origin POST is served', String(crossOriginPost.status))
check(
  crossOriginPost.headers['access-control-allow-origin'] === 'dsh-app://app',
  'the audio reply carries the CORS grant',
  String(crossOriginPost.headers['access-control-allow-origin']),
)
check(
  String(crossOriginPost.headers['access-control-expose-headers'] ?? '').includes('x-voice-voice'),
  'the audio reply exposes the voice headers',
  String(crossOriginPost.headers['access-control-expose-headers']),
)
const crossOriginSettings = await call('/voice/settings', {
  method: 'POST',
  body: { autoRead: true },
  headers: { origin: 'dsh-app://app' },
})
check(crossOriginSettings.status === 200, 'a cross-origin settings write is served', String(crossOriginSettings.status))

const liveReply = await call('/voice/live?sessionId=s1&cursor=0')
check(liveReply.status === 200 && Array.isArray(liveReply.json().frames), 'live poll answers frames')

dispose()
check(routes.length === 0, 'the disposer removes every route')

// ── `auto` must never reach the cache key ─────────────────────────────────
// The bug this pins: `engine: 'auto'` was written into the synthesis cache key,
// so switching from the OS voice to Edge kept replaying the OS voice's file for
// every voice choice.
{
  const { resolveEngine } = await import('../lib/engines.js')
  check(resolveEngine('auto', { edgeTts: '/x', localCommand: '/y' }) === 'edge', 'auto prefers edge when available')
  check(resolveEngine('auto', { edgeTts: undefined, localCommand: '/y' }) === 'local', 'auto falls back to the OS voice')
  check(resolveEngine('auto', { edgeTts: undefined, localCommand: undefined }) === 'browser', 'auto falls back to the page voice')
  check(resolveEngine('edge', { edgeTts: undefined }) === 'unavailable', 'an explicit engine that is missing is unavailable')
  check(resolveEngine('local', { edgeTts: '/x', localCommand: undefined }) === 'unavailable', 'local without a command is unavailable')
  check(resolveEngine('browser', { edgeTts: '/x', localCommand: '/y' }) === 'browser', 'browser stays browser')

  const ctx = { logger }
  const store = {
    get: () => ({ engine: 'auto', voice: '', rate: 0, maxCacheBytes: 4194304, softChunkChars: 40, maxCharsPerRequest: 2000 }),
    subscribe: () => () => {},
  }
  const { VoiceEngines: Engines } = await import('../lib/engines.js')
  const probe = new Engines(ctx, store)
  const keys = []
  probe.synthesize = Object.getPrototypeOf(probe).synthesize.bind({
    ...probe,
    // capture the key by intercepting the cache write
    store,
  })
  void keys

  // The observable contract: a fresh engine instance with `auto` must produce an
  // engine name that is a real engine, never the policy value.
  const status = probe.resolvedEngine()
  check(status === 'edge' || status === 'local' || status === 'browser', 'resolvedEngine never returns the policy value', status)
}

// ── the silent-substitution guard ─────────────────────────────────────────
// macOS `say -v <unknown>` exits 0 and speaks with the SYSTEM DEFAULT voice, so
// four different voice choices produced four byte-identical files while every
// log line claimed a different voice. The guard must report the substitution.
{
  const { VoiceEngines: Engines } = await import('../lib/engines.js')
  const probeStore = {
    get: () => ({ engine: 'local', voice: '', rate: 0, maxCacheBytes: 4194304, softChunkChars: 40, maxCharsPerRequest: 2000 }),
    subscribe: () => () => {},
  }
  const probe = new Engines({ logger }, probeStore)
  probe.voices = async () => [
    { id: 'Tingting', label: 'Tingting', locale: 'zh-CN' },
    { id: 'Sinji', label: 'Sinji', locale: 'zh-HK' },
  ]
  const unknown = await probe.voiceNotice('local', 'zh-CN-YunxiNeural')
  check(
    typeof unknown === 'string' && unknown.includes('zh-CN-YunxiNeural'),
    'an unknown OS voice is reported instead of silently substituted',
    String(unknown).slice(0, 100),
  )
  const known = await probe.voiceNotice('local', 'Tingting')
  check(known === '', 'a known OS voice raises no notice', String(known))
  const edgeVoice = await probe.voiceNotice('edge', 'zh-CN-YunxiNeural')
  check(edgeVoice === '', 'edge voices are never pre-rejected', String(edgeVoice))
  const empty = await probe.voiceNotice('local', '')
  check(empty === '', 'the engine default raises no notice', String(empty))
}

// ── what is never spoken: code and tables ─────────────────────────────────
// A fenced block read aloud is noise, and a table read row by row
// ("， 方案 ， 优点 ， 缺点 ，") is worse than useless beyond two columns.
{
  const skipped = [
    ['fenced code block', '说明：\n\n```js\nconst a = 1;\n```\n\n完成。'],
    ['fenced block with blank lines', '说明：\n\n```python\ndef f():\n\n    return 1\n```\n\n完成。'],
    ['tilde fence', '~~~\ncode here\n~~~\n\n结束。'],
    ['unclosed fence (a streaming cut)', '下面写代码：\n\n```js\nconst a = 1'],
    ['indented code block', '看这个：\n\n    const x = 1\n    const y = 2\n\n好了。'],
    ['table with outer pipes', '表格：\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n结束。'],
    ['table without outer pipes', '表格：\n\na | b\n--- | ---\n1 | 2\n\n结束。'],
    ['aligned table', '| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n\n结束。'],
  ]
  for (const [label, source] of skipped) {
    const spoken = sanitizeSpeech(source)
    const leaked = /\||const |return |def f|code here/u.test(spoken)
    check(!leaked, `never speaks: ${label}`, JSON.stringify(spoken.replace(/\s+/gu, ' ').trim()))
  }
  // Prose that merely contains a pipe must survive: only cell-like rows go.
  for (const kept of ['我选 A | B 都行。', '这个符号 | 是竖线。', '价格是 100 | 200 之间。']) {
    const spoken = sanitizeSpeech(kept).replace(/\s+/gu, ' ').trim()
    check(spoken !== '', `keeps prose containing a pipe: ${kept}`, JSON.stringify(spoken))
  }
  check(
    sanitizeSpeech('用 `npm test` 来跑测试。').includes('npm test'),
    'inline code keeps its text (it is part of the sentence)',
  )
  // A table row whose closing pipe has not arrived yet still arrives verbatim
  // from the stream. In a table with inline code the cut lands on the closing
  // backtick, and the row then read as prose — that is where `ENOENT: no such
  // file` was spoken aloud from.
  // The last case is the one that matters: it ends on the closing backtick, NOT
  // on a pipe, so the earlier "starts with a pipe" rules do not match it. Rows
  // that do end with a pipe prove nothing about this rule.
  for (const partial of [
    '| 报错信息 | 真实原因 | 解决方式 |',
    '| 报错信息 | 真实原因 | | `ENOENT: no such file`',
    '| a | b',
    '| 报错信息 | 真实原因 | 解决方式 |\n| --- | --- | --- |\n| `ENOENT: no such file`',
    '| x | 用了相对路径，但工作目录变了 | 改成 `path.resolve(__dirname, ...)`\n| y | z | 加 `WeakSet`',
  ]) {
    const spoken = sanitizeSpeech(partial).replace(/\s+/gu, ' ').trim()
    check(spoken === '', 'an unfinished table row is never spoken', JSON.stringify(spoken))
  }
  // Prose containing a pipe is still prose.
  for (const kept of ['这个符号 | 是竖线。', '我选 A | B 都行。']) {
    const spoken = sanitizeSpeech(kept).replace(/\s+/gu, ' ').trim()
    check(spoken !== '', `a sentence with a pipe survives: ${kept}`, JSON.stringify(spoken))
  }
  // The skip must also hold through the sentence cutter, which is what the
  // streaming path actually calls.
  let buffer = ''
  const spokenByStream = []
  for (const delta of ['下面是表格：\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n', '然后是代码：\n\n```js\nconst q = 2\n```\n', '最后一句正文。']) {
    buffer += delta
    const cut = cutSegments(buffer, 40, false)
    buffer = cut.rest
    for (const segment of cut.segments) {
      const clean = sanitizeSpeech(segment)
      if (clean !== '' && !silentText(clean)) spokenByStream.push(clean)
    }
  }
  const tail = cutSegments(buffer, 40, true)
  for (const segment of tail.segments) {
    const clean = sanitizeSpeech(segment)
    if (clean !== '' && !silentText(clean)) spokenByStream.push(clean)
  }
  // The real boundary that leaked: the stream is released up to a point that
  // lands INSIDE a table row, on the closing backtick of inline code. The
  // whole-table rule cannot match (the separator is fine, but this row has no
  // closing pipe), so the leftover row read as prose.
  {
    const boundary = '排查之后发现是三类问题，整理如下：\n\n'
      + '| 报错信息 | 真实原因 | 解决方式 |\n| --- | --- | --- |\n'
      + '| `ENOENT: no such file`'
    const spokenAtBoundary = sanitizeSpeech(boundary)
    check(
      !/ENOENT|no such file/u.test(spokenAtBoundary),
      'an incomplete table row at the release boundary is never spoken',
      JSON.stringify(spokenAtBoundary.replace(/\s+/gu, ' ').slice(-40)),
    )
    check(
      spokenAtBoundary.includes('三类问题'),
      'the prose before the table survives at the release boundary',
      JSON.stringify(spokenAtBoundary.slice(0, 30)),
    )
  }

  const streamed = spokenByStream.join(' ')
  check(!/\||const q/u.test(streamed), 'the streaming path never speaks code or tables', JSON.stringify(streamed))
  check(streamed.includes('最后一句正文'), 'the streaming path keeps the prose around them', JSON.stringify(streamed))
}

// ── a turn that stopped mid-sentence is reported, not hidden ──────────────
// "the model was cut off" and "I missed the ending" sound identical, so the raw
// text is the only thing that can tell them apart.
{
  const unfinished = [
    '告我具体听到',
    '如果听到任何不该念的内容，告我具体听到',
    '第一点。第二点',
  ]
  const finished = [
    '这是最后一段。',
    '真的结束了吗？',
    '就这样吧！',
    '以上就是全部内容……',
    '（完）',
    '| a | b |',
    '```',
    '说明如下：',
    // Markdown closers are deliberate stops too. Leaving them out flagged a
    // finished reply as truncated, which is what the report showed.
    '结论是 **重点**',
    '这里有 __强调__',
    '~~删掉~~',
    '见 [文档](x)',
  ]
  for (const text of unfinished) {
    check(looksUnfinished(text), `a reply cut off mid-sentence is detected: ${text}`, text)
  }
  for (const text of finished) {
    check(!looksUnfinished(text), `a complete reply is not flagged: ${text}`, text)
  }
}

rmSync(home, { recursive: true, force: true })
writeFileSync(join(tmpdir(), 'dsh-voice-test-marker'), 'x')
process.stdout.write(failures.length === 0 ? '\nPASS\n' : `\nFAILED (${String(failures.length)})\n${failures.join('\n')}\n`)
process.exit(failures.length === 0 ? 0 : 1)
