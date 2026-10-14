/**
 * The `/voice/*` HTTP surface.
 *
 * One namespaced route pair on the host webserver carries the whole browser
 * contract:
 *
 * - `GET  /voice/status`  — engine resolution, capabilities, effective settings.
 * - `GET  /voice/voices`  — the voice roster for the picker.
 * - `POST /voice/segment` — synthesise one text; the response is the encoded
 *                           audio itself (a page turns it into a blob URL).
 * - `POST /voice/settings`— persist a panel change.
 *
 * Audio crosses as raw bytes rather than base64: a spoken paragraph is tens of
 * kilobytes, and a `Blob` response feeds `URL.createObjectURL` + `<audio>`
 * without an intermediate string.
 *
 * @module dsh-voice/routes
 */

/** Per-request JSON body ceiling. */
const MAX_BODY_BYTES = 64 * 1024

/** Texts longer than this are refused before synthesis. */
const MAX_TEXT_CHARS = 5000

/**
 * Register every `/voice` route.
 *
 * @param ctx - host plugin context carrying `webServer`.
 * @param deps - `{ store, engines, live }`.
 * @returns the disposer that unregisters all four routes.
 */
export function registerRoutes(ctx, deps) {
  const { store, engines, live } = deps
  const server = ctx.get('webServer')
  if (server === undefined) return () => {}

  /**
   * One access line per voice request. The plugin's hardest failures to
   * diagnose are transport failures: "the page asked nothing" and "the page
   * asked and never got an answer" look identical in the browser, and only the
   * host log tells them apart.
   */
  const log = (req, note) => {
    const origin = header(req, 'origin') ?? '-'
    const referer = header(req, 'referer') ?? '-'
    ctx.logger?.info?.('dsh-voice: %s %s origin=%s referer=%s%s',
      req.method ?? 'GET', new URL(req.url ?? '/', 'http://dsh.internal').pathname,
      origin, referer, note === undefined ? '' : ` ${note}`)
  }

  const withLog = (handler) => (req, res) => {
    try {
      res.__voiceLog = (request) => { log(request) }
    } catch { /* a frozen response still serves the route */ }
    return handler(req, res)
  }
  const disposers = [
    server.register({ kind: 'exact', path: '/voice/status', handler: withLog((req, res) => handleStatus(req, res, deps)) }),
    server.register({ kind: 'exact', path: '/voice/voices', handler: withLog((req, res) => handleVoices(req, res, deps)) }),
    server.register({ kind: 'exact', path: '/voice/segment', methods: ['GET', 'POST', 'OPTIONS'], handler: withLog((req, res) => handleSegment(req, res, deps)) }),
    server.register({ kind: 'exact', path: '/voice/settings', methods: ['GET', 'POST', 'OPTIONS'], handler: withLog((req, res) => handleSettings(req, res, deps)) }),
    server.register({ kind: 'exact', path: '/voice/live', handler: withLog((req, res) => handleLivePoll(req, res, deps)) }),
    server.register({ kind: 'exact', path: '/voice/health', methods: ['GET', 'POST', 'OPTIONS'], handler: withLog((req, res) => handleHealth(req, res, deps)) }),
  ]
  if (typeof server.registerUpgrade === 'function') {
    try {
      disposers.push(server.registerUpgrade({ path: '/voice/live', handler: (req, socket, head) => handleLiveSocket(ctx, req, socket, head, deps) }))
    } catch (error) {
      ctx.logger?.warn?.('dsh-voice: websocket transport unavailable, polling only: %s', error?.message ?? error)
    }
  }
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * `GET /voice/live?sessionId=&cursor=` — the polling transport.
 *
 * It answers the same frame stream the websocket pushes, so the browser can
 * fall back to it on a host where `ws` is not resolvable, without a second
 * code path in the client.
 */
function handleLivePoll(req, res, deps) {
  if (preflight(req, res)) return
  if (!allow(req, res)) return
  const { live } = deps
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const sessionId = url.searchParams.get('sessionId') ?? ''
  if (sessionId === '') {
    sendJson(res, 400, { ok: false, error: 'sessionId 不能为空。' })
    return
  }
  const cursor = Number(url.searchParams.get('cursor') ?? '0')
  const page = live.since(sessionId, Number.isFinite(cursor) ? cursor : 0)
  sendJson(res, 200, { ok: true, cursor: page.cursor, frames: page.frames, reset: page.reset })
}

/**
 * `WS /voice/live?sessionId=` — the push transport.
 *
 * `ws` is resolved at call time, not at module scope: the plugin may load from
 * a profile where the dependency is hoisted beside it, or from inside the
 * application archive where only the application itself can see it. When the
 * import fails the upgrade is refused and the browser keeps polling.
 *
 * @param ctx - host plugin context (logger).
 * @param req - the upgrade request carrying `?sessionId=`.
 * @param socket - the raw upgrade socket.
 * @param head - the upgrade head bytes.
 * @param deps - `{ live }`.
 */
async function handleLiveSocket(ctx, req, socket, head, deps) {
  const { live } = deps
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const sessionId = url.searchParams.get('sessionId') ?? ''
  if (sessionId === '') {
    socket.destroy()
    return
  }
  let WebSocketServer
  try {
    ({ WebSocketServer } = await import('ws'))
  } catch (error) {
    ctx.logger?.warn?.('dsh-voice: cannot import ws (%s); refusing the upgrade so the browser polls', error?.message ?? error)
    socket.destroy()
    return
  }
  try {
    const wss = new WebSocketServer({ noServer: true })
    wss.handleUpgrade(req, socket, head, (ws) => {
      const send = (frame) => {
        if (ws.readyState === 1) {
          try {
            ws.send(JSON.stringify(frame))
          } catch { /* a closing socket drops the frame */ }
        }
      }
      const off = live.subscribe(sessionId, send)
      const heartbeat = setInterval(() => {
        if (ws.readyState === 1) {
          try {
            ws.ping()
          } catch { /* the close handler takes over */ }
        }
      }, 20000)
      heartbeat.unref?.()
      const finish = () => {
        clearInterval(heartbeat)
        off()
        try {
          wss.close()
        } catch { /* already closed */ }
      }
      ws.on('close', finish)
      ws.on('error', finish)
    })
  } catch (error) {
    ctx.logger?.warn?.('dsh-voice: websocket upgrade failed: %s', error?.message ?? error)
    socket.destroy()
  }
}

/** `GET /voice/status`. */
async function handleStatus(req, res, deps) {
  if (preflight(req, res)) return
  if (!allow(req, res)) return
  const { store, engines, live } = deps
  const settings = store.get()
  sendJson(res, 200, {
    ok: true,
    enabled: settings.enabled !== false,
    engine: settings.engine,
    resolved: engines.resolvedEngine(),
    voice: store.get().voice === '' ? engines.voiceFor() : store.get().voice,
    configuredVoice: settings.voice,
    rate: settings.rate,
    autoRead: settings.autoRead,
    readOnSettle: settings.readOnSettle,
    softChunkChars: settings.softChunkChars,
    maxCharsPerRequest: settings.maxCharsPerRequest,
    capabilities: engines.capabilities(),
    settingsFile: store.file,
    liveSessions: live.size,
  })
}

/** `GET|POST /voice/health?force=1` — is Edge actually reachable right now? */
async function handleHealth(req, res, deps) {
  if (preflight(req, res)) return
  if (!allow(req, res)) return
  const { engines } = deps
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const force = url.searchParams.get('force') === '1'
  const health = await engines.checkEdge({ force })
  sendJson(res, 200, {
    ok: health.ok !== false,
    reachable: health.ok === true,
    checkedAt: health.at,
    ms: health.ms,
    message: health.message ?? '',
    engine: engines.resolvedEngine(),
  })
}

/** `GET /voice/voices?engine=`. */
async function handleVoices(req, res, deps) {
  if (preflight(req, res)) return
  if (!allow(req, res)) return
  const { engines, store } = deps
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const requested = url.searchParams.get('engine') ?? undefined
  // `auto` is the configured value, not a concrete engine: resolve it the same
  // way synthesis does so the picker lists the roster that will actually speak.
  const engine = requested === undefined || requested === '' || requested === 'auto'
    ? engines.resolvedEngine()
    : requested
  if (engine !== 'edge' && engine !== 'local' && engine !== 'browser') {
    sendJson(res, 400, { ok: false, error: `未知的语音引擎：${engine}` })
    return
  }
  if (engine === 'browser') {
    sendJson(res, 200, { ok: true, engine, voices: [], defaultVoice: '', note: '浏览器引擎的音色由页面自身的语音列表提供。' })
    return
  }
  const voices = await engines.voices(engine)
  sendJson(res, 200, { ok: true, engine, voices, defaultVoice: engines.voiceFor(engine), configured: store.get().voice })
}

/** `POST /voice/segment`. */
async function handleSegment(req, res, deps) {
  if (preflight(req, res)) return
  if (!allow(req, res)) return
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    sendJson(res, 405, { ok: false, error: '请使用 POST。' })
    return
  }
  const body = await readJson(req, res)
  if (body === undefined) return
  const { engines, store } = deps

  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (text === '') {
    sendJson(res, 400, { ok: false, error: 'text 不能为空。' })
    return
  }
  const limit = Math.min(MAX_TEXT_CHARS, numberOr(store.get().maxCharsPerRequest, MAX_TEXT_CHARS))
  if (text.length > limit) {
    sendJson(res, 413, { ok: false, error: `text 超过 ${limit} 字符上限。` })
    return
  }

  const overrides = {}
  if (typeof body.engine === 'string' && body.engine !== '') overrides.engine = body.engine
  if (typeof body.voice === 'string' && body.voice !== '') overrides.voice = body.voice
  if (typeof body.rate === 'number' && Number.isFinite(body.rate)) overrides.rate = body.rate

  try {
    const result = await engines.synthesize(text, overrides)
    res.statusCode = 200
    res.writeHead(200, {
      ...corsHeaders(res),
      'content-type': result.mime,
      'content-length': String(result.bytes.length),
      'cache-control': 'no-store',
      'x-voice-engine': result.engine,
      'x-voice-voice': encodeURIComponent(result.voice ?? ''),
      'x-voice-rate': String(result.rate ?? 0),
      'x-voice-duration': result.duration === null || result.duration === undefined ? '' : result.duration.toFixed(3),
      'x-voice-cached': result.cached === true ? '1' : '0',
      // A substituted voice is reported, never hidden: the page shows it.
      ...(result.notice === undefined || result.notice === ''
        ? {}
        : { 'x-voice-notice': encodeURIComponent(result.notice) }),
    })
    res.end(result.bytes)
  } catch (error) {
    const code = error?.code
    const status = code === 'engine-unavailable' ? 503 : code === 'engine-browser' ? 400 : 500
    sendJson(res, status, { ok: false, error: error?.message ?? String(error), code: code ?? 'engine-failed' })
  }
}

/** `POST /voice/settings`. */
async function handleSettings(req, res, deps) {
  if (preflight(req, res)) return
  if (!allow(req, res)) return
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    sendJson(res, 405, { ok: false, error: '请使用 POST。' })
    return
  }
  const body = await readJson(req, res)
  if (body === undefined) return
  const { store } = deps
  const outcome = store.update(body)
  sendJson(res, outcome.issues.length === 0 ? 200 : 400, {
    ok: outcome.issues.length === 0,
    settings: outcome.settings,
    issues: outcome.issues,
    file: outcome.file,
  })
}

/**
 * The CORS grant for one response.
 *
 * The desktop shell serves the page from `dsh-app://app/`, so its calls to the
 * loopback webserver are cross-origin: without this header the page cannot read
 * the answer at all. The origin was already accepted by {@link allow}, so
 * echoing it back is safe.
 *
 * @param res - the response being written.
 * @returns headers to merge into the reply.
 */
function corsHeaders(res) {
  const granted = res.__voiceOrigin
  // A request from a custom-scheme page may carry no Origin at all; the routes
  // are loopback-only and credential-free, so a wildcard grant is safe and
  // keeps the answer readable.
  if (granted === undefined || granted === '') return { 'access-control-allow-origin': '*' }
  return {
    'access-control-allow-origin': granted,
    'access-control-expose-headers': 'x-voice-engine, x-voice-voice, x-voice-rate, x-voice-duration, x-voice-cached',
  }
}

/**
 * Answer this request when it is a CORS preflight.
 *
 * A preflight the server does not answer is a request the browser never sends,
 * and the webserver's own 405 fallback would swallow the `OPTIONS` before any
 * route sees it.
 *
 * @param req - the request.
 * @param res - the response.
 * @returns true when the request was a preflight and has been answered.
 */
function preflight(req, res) {
  if ((req.method ?? 'GET').toUpperCase() !== 'OPTIONS') return false
  const origin = header(req, 'origin')
  const headers = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': header(req, 'access-control-request-headers') ?? 'content-type',
    'access-control-max-age': '600',
    'cache-control': 'no-store',
    'content-length': '0',
  }
  headers['access-control-allow-origin'] = origin === undefined || origin === '' ? '*' : origin
  res.writeHead(204, headers)
  res.end()
  return true
}

/**
 * Reject a cross-origin caller. The web composition serves the GUI from its own
 * origin; a plugin route must not become a general-purpose synthesis endpoint
 * for any page in the browser, so requests carrying a foreign `Origin` are
 * refused while same-origin and origin-less (the desktop app protocol) calls
 * pass.
 */
function allow(req, res) {
  // `res` carries the tracer installed by the route registrar.
  res.__voiceLog?.(req)
  const origin = header(req, 'origin')
  if (origin !== undefined && origin !== '') res.__voiceOrigin = origin
  if (origin !== undefined && origin !== '') {
    const host = header(req, 'host') ?? ''
    let sameOrigin = false
    try {
      sameOrigin = new URL(origin).host === host
    } catch {
      sameOrigin = false
    }
    if (!sameOrigin) {
      // The desktop shell serves the app from a custom scheme; allow exactly
      // that scheme plus loopback, refuse the rest.
      const scheme = safeProtocol(origin)
      if (scheme !== 'dsh-app:' && scheme !== 'file:') {
        sendJson(res, 403, { ok: false, error: 'cross-origin voice request refused' })
        return false
      }
    }
  }
  return true
}

/** The protocol of one origin string, or ''. */
function safeProtocol(origin) {
  try {
    return new URL(origin).protocol
  } catch {
    return ''
  }
}

/** Read one header from the structural request face. */
function header(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : undefined
}

/** Read and parse one JSON request body, answering 4xx itself on failure. */
async function readJson(req, res) {
  const length = Number(header(req, 'content-length') ?? '0')
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    sendJson(res, 413, { ok: false, error: '请求体过大。' })
    return undefined
  }
  const chunks = []
  let total = 0
  try {
    for await (const chunk of req) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      total += buffer.length
      if (total > MAX_BODY_BYTES) {
        sendJson(res, 413, { ok: false, error: '请求体过大。' })
        return undefined
      }
      chunks.push(buffer)
    }
  } catch (error) {
    sendJson(res, 400, { ok: false, error: `读取请求体失败：${error?.message ?? error}` })
    return undefined
  }
  if (total === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象。' })
      return undefined
    }
    return parsed
  } catch {
    sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON。' })
    return undefined
  }
}

/** Write one JSON response. */
function sendJson(res, status, payload) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    ...corsHeaders(res),
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
  })
  res.end(bytes)
}

/** A finite number, or the fallback. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
