#!/usr/bin/env node
/**
 * Integration smoke test for the browser bundle.
 *
 * It executes `lib/client.js` in a stubbed browser environment — a
 * `__ModuleLoader__`, a minimal `react`, a slot registry that records every
 * registration, and a fake `fetch` — then calls the plugin's `apply` and
 * asserts the whole wiring runs without throwing:
 *
 * - the module factory executes and exports `name` / `inject` / `apply`,
 * - the stylesheet installs once,
 * - both chat slots and the console slot register with the expected shape,
 * - every registered component renders (React is real enough for hooks),
 * - a simulated live stream drives the reader and the host contract.
 *
 * Run with `node scripts/smoke-client.mjs`.
 *
 * @module dsh-voice/scripts/smoke-client
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** Every failure found; the script exits non-zero when it is non-empty. */
/** The speed ladder the console offers (mirrors `RATE_CHOICES`). */
const RATE_LADDER = [0.5, 0.75, 1, 1.5, 2]

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

/** A minimal element that supports the DOM surface the plugin touches. */
function makeElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    style: {},
    dataset: {},
    attributes: {},
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    parentNode: null,
    offsetWidth: 340,
    offsetHeight: 200,
    setAttribute(name, value) { this.attributes[name] = value },
    getAttribute(name) { return this.attributes[name] ?? null },
    removeAttribute(name) { delete this.attributes[name] },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child },
    removeChild(child) { this.children = this.children.filter((item) => item !== child); return child },
    remove() { this.parentNode?.removeChild(this) },
    listeners: new Map(),
    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? []
      list.push(fn)
      this.listeners.set(type, list)
    },
    removeEventListener(type, fn) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== fn))
    },
    /** Fire one listener registered on this element. */
    fire(type, event) {
      for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    /** Walk up the real parent chain, so a control press can be recognised. */
    closest(selector) {
      const wanted = String(selector).split(',').map((part) => part.trim().toLowerCase())
      let node = this
      while (node !== null && node !== undefined) {
        const tag = String(node.tagName ?? '').toLowerCase()
        const classes = String(node.className ?? '').split(/\s+/)
        if (wanted.some((part) => {
          if (part === tag) return true
          if (part.startsWith('.') && classes.includes(part.slice(1))) return true
          // attribute selectors, e.g. [data-dsh-voice-no-drag]
          if (part.startsWith('[') && part.endsWith(']')) {
            const name = part.slice(1, -1).split('=')[0].trim()
            return Object.hasOwn(node.attributes ?? {}, name)
          }
          return false
        })) return node
        node = node.parentNode
      }
      return null
    },
    querySelector() { return null },
    querySelectorAll() { return [] },
    getBoundingClientRect() { return { left: 0, top: 0, width: this.offsetWidth, height: this.offsetHeight } },
    focus() {},
    load() {},
    play() { return Promise.resolve() },
    pause() {},
    contains(node) {
      let current = node
      while (current !== null && current !== undefined) {
        if (current === this) return true
        current = current.parentNode
      }
      return false
    },
  }
  return element
}

/** The React stand-in: hooks with a stable per-render slot list. */
function makeReact() {
  const states = []
  const effects = []
  /** Hook index -> the DOM node its callback ref should receive at commit. */
  const refTargets = new Map()
  let cursor = 0
  let rendering = false
  /** Which component the current slots belong to (see `__begin`). */
  let lastKey = ''
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children },
    __element: true,
  })
  return {
    __states: states,
    __effects: effects,
    __refTargets: refTargets,
    default: null,
    createElement,
    useState(initial) {
      const index = cursor
      cursor += 1
      if (states[index] === undefined) states[index] = { value: typeof initial === 'function' ? initial() : initial }
      const set = (next) => {
        states[index].value = typeof next === 'function' ? next(states[index].value) : next
      }
      return [states[index].value, set]
    },
    useEffect(fn) {
      effects.push(fn)
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (states[index] === undefined) states[index] = { value: { current: initial } }
      return states[index].value
    },
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    Fragment: 'Fragment',
    /**
     * Start a render of one component.
     *
     * Real React gives every component instance its own hook scope. This stub
     * renders components one at a time from a single slot list, so without a
     * boundary the slots of two components collide: rendering `SpeakerButton`
     * after `VoiceConsole` made `busy` (slot 1, a boolean) read `forceVoices`
     * (slot 1, a growing counter), and the button came out `disabled={2}`.
     *
     * Slots are therefore kept per component key and dropped when the key
     * changes, which preserves a component's own state across its own
     * re-renders while isolating it from every other component.
     *
     * @param key - identifies the component being rendered (default `'default'`).
     */
    __begin(key = 'default') {
      if (key !== lastKey) {
        states.length = 0
        lastKey = key
      }
      cursor = 0
      rendering = true
    },
    /**
     * Finish a render: hand each callback ref its node (the way React does at
     * commit) and then flush the effects the render registered.
     */
    __end() {
      rendering = false
      for (const [index, state] of states.entries()) {
        if (typeof state?.value !== 'function') continue
        const node = refTargets.get(index)
        if (node === undefined) continue
        try {
          state.value(node)
        } catch { /* a throwing ref is the component's problem, not the stub's */ }
      }
      const pending = effects.splice(0, effects.length)
      for (const fn of pending) fn()
    },
    get __rendering() { return rendering },
  }
}

/** Install the browser stubs and return the handles the test inspects. */
function installEnvironment() {
  /** Document-level listeners, so a popup's dismissal can be exercised. */
  const documentListeners = new Map()
  const documentLog = []
  const document = {
    head: makeElement('head'),
    body: makeElement('body'),
    createElement: (tag) => makeElement(tag),
    querySelector: () => null,
    addEventListener(type, fn) {
      const list = documentListeners.get(type) ?? []
      list.push(fn)
      documentListeners.set(type, list)
      documentLog.push(`+${type} (now ${String(list.length)})`)
    },
    removeEventListener(type, fn) {
      const next = (documentListeners.get(type) ?? []).filter((item) => item !== fn)
      documentListeners.set(type, next)
      documentLog.push(`-${type} (now ${String(next.length)})`)
    },
    documentElement: makeElement('html'),
  }
  const storage = new Map()
  const requests = []
  const sockets = []
  const react = makeReact()

  class FakeAudio {
    constructor() {
      this.src = ''
      this.currentTime = 0
      this.duration = 0
      this.paused = true
      this.ended = false
      this.listeners = new Map()
    }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? []
      list.push(fn)
      this.listeners.set(type, list)
    }
    removeEventListener() {}
    emit(type) {
      for (const fn of this.listeners.get(type) ?? []) fn({ type })
    }
    play() {
      this.paused = false
      this.emit('play')
      setTimeout(() => this.finish(this.duration || 1), 2)
      return Promise.resolve()
    }
    pause() { this.paused = true; this.emit('pause') }
    load() {}
    removeAttribute(name) { if (name === 'src') this.src = '' }
    /** Finish the current segment the way a browser would. */
    finish(duration) {
      this.duration = duration
      this.ended = true
      this.emit('ended')
    }
  }

  class FakeWebSocket {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.listeners = new Map()
      sockets.push(this)
    }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? []
      list.push(fn)
      this.listeners.set(type, list)
    }
    emit(type, payload) {
      for (const fn of this.listeners.get(type) ?? []) fn(payload ?? {})
    }
    open() { this.readyState = 1; this.emit('open') }
    /** Deliver one host frame the way the socket does. */
    send(frame) { this.emit('message', { data: JSON.stringify(frame) }) }
    close() { this.readyState = 3; this.emit('close') }
    ping() {}
  }

  const registrations = []
  const slotRegistry = {
    /** The synthetic slot tree: everything the plugin targets must be declared. */
    declared: new Set([
      'conversation.chat.assistant-actions',
      'conversation.input.left',
      'shell.overlay',
    ]),
    inject(name, fn) {
      if (!this.declared.has(name)) throw new Error(`slot "${name}" is not declared`)
      return fn()
    },
    register(options, component) {
      if (!this.declared.has(options.name)) throw new Error(`slot "${options.name}" is not declared`)
      registrations.push({ options, component })
      return () => {
        const at = registrations.findIndex((item) => item.component === component)
        if (at >= 0) registrations.splice(at, 1)
      }
    },
  }

  const context = {
    slots: slotRegistry,
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'sessions') return sessionsApi
      return undefined
    },
    logger: { info() {}, warn() {}, debug() {} },
  }

  /** A tiny session-controller stand-in with a real event window. */
  const entries = []
  const sessionsApi = {
    binding: (id) => ({
      sessionId: id,
      session: {
        eventSource: {
          getSnapshot: () => ({ entries, revision: entries.length }),
          subscribe: (fn) => {
            window.__eventListeners.push(fn)
            return () => {
              window.__eventListeners = window.__eventListeners.filter((item) => item !== fn)
            }
          },
        },
      },
    }),
  }

  const windowListeners = new Map()
  const window = {
    __eventListeners: [],
    /** Record window-level listeners so a drag can be driven. */
    addEventListener(type, fn) {
      const list = windowListeners.get(type) ?? []
      list.push(fn)
      windowListeners.set(type, list)
    },
    removeEventListener(type, fn) {
      windowListeners.set(type, (windowListeners.get(type) ?? []).filter((item) => item !== fn))
    },
    document,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value) },
      removeItem: (key) => { storage.delete(key) },
    },
    innerWidth: 1440,
    innerHeight: 900,
    location: { protocol: 'http:', host: '127.0.0.1:19387' },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), options })
      if (String(url).includes('/voice/status')) {
        return jsonResponse({
          ok: true,
          enabled: true,
          engine: 'auto',
          resolved: 'edge',
          configuredVoice: '',
          rate: 0,
          autoRead: true,
          readOnSettle: false,
          softChunkChars: 40,
          maxCharsPerRequest: 800,
          capabilities: { platform: 'darwin', edge: { command: '/usr/local/bin/edge-tts' }, local: { command: '/usr/bin/say' } },
        })
      }
      if (String(url).includes('/voice/voices')) {
        return jsonResponse({
          ok: true,
          engine: 'edge',
          voices: [{ id: 'zh-CN-XiaoxiaoNeural', label: 'Xiaoxiao', locale: 'zh-CN', gender: 'Female' }],
          defaultVoice: 'zh-CN-XiaoxiaoNeural',
        })
      }
      if (String(url).includes('/voice/settings')) {
        return jsonResponse({ ok: true, settings: JSON.parse(options.body ?? '{}'), issues: [] })
      }
      if (String(url).includes('/voice/live')) {
        return jsonResponse({ ok: true, cursor: 0, frames: [], reset: false })
      }
      if (String(url).includes('/voice/segment')) {
        return {
          ok: true,
          status: 200,
          headers: {
            get: (name) => ({
              'x-voice-duration': '1.250',
              'x-voice-engine': 'edge',
              'x-voice-voice': 'zh-CN-XiaoxiaoNeural',
              'x-voice-cached': '0',
            })[String(name).toLowerCase()] ?? null,
          },
          blob: async () => ({ size: 1024, type: 'audio/mpeg' }),
          text: async () => '',
        }
      }
      return jsonResponse({ ok: false }, 404)
    },
    WebSocket: FakeWebSocket,
    Audio: FakeAudio,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    speechSynthesis: { speak() {}, cancel() {} },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text } },
  }
  window.window = window

  /** One JSON fetch reply. */
  function jsonResponse(payload, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }
  }

  const loaded = []
  window.__ModuleLoader__ = {
    load: (definition) => { loaded.push(definition) },
  }

  globalThis.window = window
  globalThis.document = document
  globalThis.localStorage = window.localStorage
  globalThis.fetch = window.fetch
  globalThis.WebSocket = FakeWebSocket
  globalThis.Audio = FakeAudio
  globalThis.location = window.location
  globalThis.URL = window.URL
  globalThis.speechSynthesis = window.speechSynthesis
  globalThis.SpeechSynthesisUtterance = window.SpeechSynthesisUtterance
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => { fn(0) }, 0)

  /** Fire one document-level event at every registered listener. */
  const fireDocument = (type, event) => {
    for (const fn of [...(documentListeners.get(type) ?? [])]) fn(event)
  }

  return {
    window, document, context, registrations, requests, sockets, react, loaded, entries, storage,
    fireDocument,
    documentListenerTypes: () => [...documentListeners.keys()],
    /** Fire one window-level event (the drag loop listens here). */
    fireWindow: (type, event) => {
      for (const fn of [...(windowListeners.get(type) ?? [])]) fn(event)
    },
    documentLog: () => [...documentLog],
  }
}

/**
 * Await one expression evaluated against the plugin's published debug handle.
 *
 * The bundle executes inside its own function scope, so the test reaches the
 * live objects exactly the way a user does: through `globalThis.__DSH_VOICE__`.
 *
 * @param env - the installed environment.
 * @param expression - an expression evaluated with `__DSH_VOICE__` in scope.
 * @returns the resolved value.
 */
async function evaluate(env, expression) {
  const runner = new Function('__DSH_VOICE__', `return (${expression})`)
  return await runner(env.window.__DSH_VOICE__)
}

/**
 * Render the console component once.
 *
 * @returns the rendered element tree.
 */
function renderConsoleTree() {
  const registration = globalThis.__SMOKE_CONSOLE_REG__
  const react = globalThis.__SMOKE_REACT__
  const injected = registration.options.inject('session-smoke')
  react.__begin('console')
  const element = registration.component(injected)
  // Find the header's callback ref and register the node React would hand it,
  // so the native drag listener is exercised with a REAL element.
  const findHead = (node, out = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return out
    if (node.props !== undefined) {
      out.push(node)
      const kids = node.props.children
      for (const child of Array.isArray(kids) ? kids.flat(Infinity) : [kids]) findHead(child, out)
    }
    return out
  }
  const headNode = findHead(element).find((node) => node.props.className === 'dsh-voice-head')
  if (typeof headNode?.props?.ref === 'function') {
    const head = makeElement('div')
    head.className = 'dsh-voice-head'
    const panel = makeElement('div')
    panel.className = 'dsh-voice-console'
    panel.setAttribute('data-dsh-voice-console', '1')
    panel.appendChild(head)
    react.__refTargets.set(react.__states.findIndex((state) => state?.value === headNode.props.ref), head)
  }
  react.__end()
  return element
}

/** Run the smoke test. */
async function main() {
  process.stdout.write('dsh-voice client bundle smoke test\n')
  const env = installEnvironment()
  globalThis.__SMOKE_REACT__ = env.react
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

  // The bundle is a classic script that registers itself with the loader.
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'localStorage', 'fetch', 'WebSocket', 'Audio', 'location', 'URL', 'speechSynthesis', 'SpeechSynthesisUtterance', 'require', 'module', source)
  const loaderModule = { exports: {} }
  run(
    env.window,
    env.document,
    env.window.localStorage,
    env.window.fetch,
    env.window.WebSocket,
    env.window.Audio,
    env.window.location,
    env.window.URL,
    env.window.speechSynthesis,
    env.window.SpeechSynthesisUtterance,
    (specifier) => {
      if (specifier === 'react') return env.react
      if (specifier === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
      if (specifier === 'react/jsx-runtime') return { jsx: env.react.createElement, jsxs: env.react.createElement }
      throw new Error(`unexpected require("${specifier}")`)
    },
    loaderModule,
  )

  check(env.loaded.length === 1, 'bundle registers exactly one module', `got ${String(env.loaded.length)}`)
  const definition = env.loaded[0]
  check(definition?.id === 'dsh-voice', 'bundle id is dsh-voice', String(definition?.id))

  const exportsValue = definition.factory((specifier) => {
    if (specifier === 'react') return env.react
    throw new Error(`unexpected require("${specifier}")`)
  })
  check(exportsValue.name === 'dsh-voice', 'exports name', String(exportsValue.name))
  check(Array.isArray(exportsValue.inject) && exportsValue.inject.includes('slots'), 'exports inject')

  // Apply the plugin.
  exportsValue.apply(env.context)
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))

  check(env.document.head.children.some((node) => node.attributes['data-dsh-voice-styles'] === '1'), 'stylesheet installed')
  globalThis.__SMOKE_CONSOLE_REG__ = env.registrations.find((item) => item.options.name === 'shell.overlay')
  // the bundle publishes its live objects on the page global
  env.window.navigator = { clipboard: { writeText: async () => {} } }
  const names = env.registrations.map((item) => item.options.name).sort()
  check(
    names.join(',') === 'conversation.chat.assistant-actions,conversation.input.left,shell.overlay',
    'three slots registered',
    names.join(','),
  )
  const action = env.registrations.find((item) => item.options.name === 'conversation.chat.assistant-actions')
  check(action?.options.id === 'voice', 'action slot id')
  check(typeof action?.options.inject === 'function', 'action slot inject is a function')

  // Render every registered component once with its injected face.
  for (const registration of env.registrations) {
    const injected = registration.options.inject('session-smoke')
    env.react.__begin(`screen:${registration.options.name}`)
    let element
    try {
      element = registration.component({ ...injected, ...(registration.options.name === 'conversation.chat.assistant-actions' ? { messageId: 'msg-1', turn: 1 } : {}) })
    } catch (error) {
      check(false, `render ${registration.options.name}`, error.message)
      continue
    }
    env.react.__end()
    check(true, `render ${registration.options.name}`)
    if (registration.options.name === 'shell.overlay') {
      check(element?.type === 'div' && element.props['data-dsh-voice-console'] === '1', 'console element shape')
    }
    if (registration.options.name === 'conversation.chat.assistant-actions') {
      check(element?.type === 'button', 'speaker button element')
    }
    if (registration.options.name === 'conversation.input.left') {
      check(element === null, 'session probe renders nothing')
    }
  }

  // The live loop: a turn streams, the reader synthesises and plays it.
  const probe = env.registrations.find((item) => item.options.name === 'conversation.input.left')
  const probeProps = probe.options.inject('session-smoke')
  env.react.__begin('probe')
  probe.component(probeProps)
  env.react.__end()
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))

  check(env.sockets.length === 1, 'live socket opened', `got ${String(env.sockets.length)}`)
  const socket = env.sockets[0]
  check(String(socket.url).includes('sessionId=session-smoke'), 'socket carries the session id', String(socket.url))
  socket.open()
  socket.send({ type: 'start', sessionId: 'session-smoke', attemptId: 'a1', turn: 3, step: 1 })
  // A model streams whole lines: the reader waits for the first COMPLETE line,
  // because a released fragment of a table row or a fence cannot be taken back.
  socket.send({ type: 'delta', sessionId: 'session-smoke', text: '你好，我是语音助手。这是第二句话，' })
  socket.send({ type: 'delta', sessionId: 'session-smoke', text: '它比较长需要等待合成。\n' })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 80))

  const segmentCalls = env.requests.filter((request) => request.url.includes('/voice/segment'))
  check(segmentCalls.length >= 1, 'synthesis requested for streamed text', `calls=${String(segmentCalls.length)}`)
  const firstBody = segmentCalls.length > 0 ? JSON.parse(segmentCalls[0].options.body) : {}
  check(typeof firstBody.text === 'string' && firstBody.text.length > 0, 'synthesis body carries text', JSON.stringify(firstBody.text ?? null))
  check(!/[#*`|]/u.test(firstBody.text ?? ''), 'synthesis text is Markdown-free', firstBody.text)

  // The settle path: the durable message becomes replayable.
  env.entries.push({
    type: 'durable',
    event: {
      type: 'assistant/message',
      seq: 1,
      time: Date.now(),
      data: {
        turn: 3,
        messageId: 'msg-1',
        blocks: [{ kind: 'text', text: '你好，我是语音助手。' }],
      },
    },
  })
  for (const listener of env.window.__eventListeners) listener()
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))

  const actionProps = action.options.inject('session-smoke')
  env.react.__begin('speaker')
  const button = action.component({ ...actionProps, messageId: 'msg-1', turn: 3 })
  env.react.__end()
  check(button?.props?.disabled === false, 'speaker button is enabled')
  button.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 80))
  const replayCalls = env.requests.filter((request) => request.url.includes('/voice/segment'))
  check(replayCalls.length > segmentCalls.length, 'replay synthesises the settled message', `before=${String(segmentCalls.length)} after=${String(replayCalls.length)}`)

  // ── changing the voice must be audible immediately ──────────────────────
  // The bug this pins: auto-read synthesises a whole short reply before the
  // reader has heard it, so a switch that only re-queued *unsynthesised* text
  // left the already-produced audio in the old voice and looked like a no-op.
  const readerHandle = await evaluate(env, 'globalThis.__DSH_VOICE__.reader')
  const beforeVoice = await evaluate(env, 'globalThis.__DSH_VOICE__.reader.segments.map(s => s.voice)')
  const beforeCalls = env.requests.filter((request) => request.url.includes('/voice/segment')).length
  await evaluate(env, `(async () => { await globalThis.__DSH_VOICE__.voice.setVoice('zh-CN-YunxiNeural') })()`)
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 120))
  const afterCalls = env.requests.filter((request) => request.url.includes('/voice/segment'))
  const afterBodies = afterCalls.slice(beforeCalls).map((request) => JSON.parse(request.options.body))
  check(afterBodies.length > 0, 'switching the voice re-synthesises the reading', `new calls=${String(afterBodies.length)}`)
  check(
    afterBodies.every((body) => body.voice === 'zh-CN-YunxiNeural'),
    'every re-synthesised segment uses the new voice',
    JSON.stringify(afterBodies.map((body) => body.voice)),
  )
  // No request URL may ever contain the string "undefined": the facade has no
  // engine state, so a `this.baseUrl` typo used to produce `/undefined/...`.
  const urls = env.requests.map((request) => request.url)
  check(
    urls.every((url) => !url.includes('undefined')),
    'no request URL contains "undefined"',
    urls.filter((url) => url.includes('undefined')).join(', '),
  )
  const override = await evaluate(env, 'globalThis.__DSH_VOICE__.reader.voiceOverride')
  check(override === 'zh-CN-YunxiNeural', 'the reader keeps the new voice override', String(override))
  void beforeVoice
  void readerHandle

  const sample = await evaluate(env, "globalThis.__DSH_VOICE__.voice.sampleVoice('zh-CN-YunxiNeural')")
  check(sample !== undefined, 'the sample action runs', JSON.stringify(sample))
  const sampleCalls = env.requests.filter((request) => request.url.includes('/voice/segment'))
  const sampleUrls = sampleCalls.map((request) => request.url)
  check(
    sampleUrls.every((url) => url.startsWith('/voice/segment')),
    'every synthesis request targets /voice/segment',
    sampleUrls.join(', '),
  )

  // A whole reply must never be sent as one oversized request: the host caps a
  // single synthesis, and a 413 leaves the reader with nothing to play.
  const longReply = '这是一句很长的测试文本，用来验证超长回复会被正确切分。'.repeat(60)
  const splitCount = await evaluate(env, `(async () => {
    const reader = globalThis.__DSH_VOICE__.reader
    const before = globalThis.__DEEPSEEK_VOICE_CALLS__ = 0
    return reader.playText(${JSON.stringify(longReply)}, { sessionId: 'session-smoke', turn: 9 })
  })()`)
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400))
  const longBodies = env.requests
    .filter((request) => request.url.includes('/voice/segment'))
    .map((request) => JSON.parse(request.options.body).text)
    .filter((text) => text.includes('超长回复'))
  check(typeof splitCount === 'number' && splitCount > 1, 'a long reply is split into several segments', String(splitCount))
  check(
    longBodies.every((text) => text.length <= 800),
    'no synthesis request exceeds the host ceiling',
    `max=${String(Math.max(0, ...longBodies.map((text) => text.length)))}`,
  )
  // Splitting must not lose a character: the reader has to say the whole reply.
  const strip = (value) => value.replace(/\s/gu, '')
  const recombined = strip(longBodies.join(''))
  const original = strip(longReply)
  check(
    recombined === original,
    'the split reply preserves every character',
    `sent=${String(recombined.length)} original=${String(original.length)}`,
  )
  // And an unpunctuated run must still be cut, not sent whole.
  const runText = '一二三四五六七八九十'.repeat(300)
  await evaluate(env, `(async () => { await globalThis.__DSH_VOICE__.reader.playText(${JSON.stringify(runText)}, { sessionId: 'session-smoke', turn: 10 }) })()`)
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400))
  const runBodies = env.requests
    .filter((request) => request.url.includes('/voice/segment'))
    .map((request) => JSON.parse(request.options.body).text)
    .filter((text) => text.startsWith('一二三四五六七八九十'))
  check(runBodies.length > 1, 'an unpunctuated run is cut into pieces', String(runBodies.length))
  check(
    runBodies.every((text) => text.length <= 800),
    'every unpunctuated piece stays under the ceiling',
    `max=${String(Math.max(0, ...runBodies.map((text) => text.length)))}`,
  )
  check(
    env.requests.filter((request) => request.url.includes('/voice/segment')).every((request) => request.url.includes('?t=')),
    'every synthesis URL carries a cache-buster',
    env.requests.filter((request) => request.url.includes('/voice/segment') && !request.url.includes('?t=')).map((request) => request.url).join(', '),
  )
  check(
    env.requests.every((request) => request.options.cache === 'no-store' || request.options.method === undefined),
    'every request opts out of the HTTP cache',
    env.requests.filter((request) => request.options.method !== undefined && request.options.cache !== 'no-store').map((request) => request.url).join(', '),
  )

  // ── speed is applied at playback, not at synthesis ──────────────────────
  // The neural service caps its own speed-up (`+100%`, `+150%` and `+200%`
  // returned byte-identical audio), so the player scales the media instead:
  // instant, pitch-preserving, and no re-synthesis.
  const rateCallsBefore = env.requests.filter((request) => request.url.includes('/voice/segment')).length
  const rateResult = await evaluate(env, `(async () => {
    const v = globalThis.__DSH_VOICE__
    const applied = await v.voice.setRateMultiplier(2)
    return { applied, multiplier: v.reader.rateMultiplier, playbackRate: v.reader.audio.playbackRate, preservesPitch: v.reader.audio.preservesPitch }
  })()`)
  check(rateResult.applied === 2, 'the speed control accepts a multiplier', JSON.stringify(rateResult))
  check(rateResult.multiplier === 2, 'the reader records the multiplier', String(rateResult.multiplier))
  check(rateResult.playbackRate === 2, 'the media element is scaled', String(rateResult.playbackRate))
  check(rateResult.preservesPitch === true, 'pitch preservation is requested', String(rateResult.preservesPitch))
  const rateCallsAfter = env.requests.filter((request) => request.url.includes('/voice/segment')).length
  check(rateCallsAfter === rateCallsBefore, 'changing the speed never re-synthesises', `${String(rateCallsBefore)} -> ${String(rateCallsAfter)}`)

  // The timeline is listening time, so media seconds divide by the speed.
  const timeline = await evaluate(env, `(() => {
    const r = globalThis.__DSH_VOICE__.reader
    r.segments = [{ id: 'x', text: 'a', state: 'ready', duration: 10, url: null, notice: '' }]
    r.cursor = 0
    r.audio.currentTime = 5
    const at2x = { offset: r.currentOffset, total: r.duration }
    r.rateMultiplier = 1
    const at1x = { offset: r.currentOffset, total: r.duration }
    return { at2x, at1x }
  })()`)
  check(Math.abs(timeline.at2x.offset - 2.5) < 0.01, 'at 2x, media seconds halve on the timeline', String(timeline.at2x.offset))
  check(Math.abs(timeline.at2x.total - 5) < 0.01, 'at 2x, a 10s segment is 5s of listening', String(timeline.at2x.total))
  check(Math.abs(timeline.at1x.offset - 5) < 0.01, 'at 1x, the timeline is media time', String(timeline.at1x.offset))

  // ── a code block must never be spoken, however it is streamed ───────────
  // The bug this pins: sentences were cut from the RAW stream and sanitized one
  // by one, so a fence marker and its content landed in different pieces and the
  // sanitizer could no longer see a code block at all. Identifiers were read out
  // (`client`, `await`, `console`).
  {
    // the bundle publishes its live objects on `globalThis`
    const live = globalThis.__DSH_VOICE__
    const bridge = live?.bridge
    const sessionId = 'session-code'
    // Auto-read only follows the session the reader is looking at; the composer
    // probe establishes that in the app.
    live.voice.setCurrentSession(sessionId)
    // the bridge owns one session reader per session; instrument that one
    const spoken = []
    const reader = live?.reader
    if (reader === undefined) {
      check(false, 'the live objects are reachable for the code-block scenario')
    } else {
    const originalEnqueue = reader.enqueue.bind(reader)
    reader.enqueue = (texts, meta) => { spoken.push(...texts); return originalEnqueue(texts, meta) }

    const reply = '接入方式其实很简单：\n\n```js\nimport { Client } from \'@example/sdk\'\n\nconst client = new Client({\n  region: \'ap-east-1\',\n  timeout: 3000,\n})\n\nawait client.connect()\nconsole.log(result.rows.length)\n```\n\n上面这段代码做了三件事。'
    bridge.onFrame(sessionId, JSON.stringify({ type: 'start', sessionId, attemptId: 'code', turn: 1 }))

    // a deliberately awkward delta size: it splits fences and identifiers
    for (let index = 0; index < reply.length; index += 17) {
      bridge.onFrame(sessionId, JSON.stringify({ type: 'delta', sessionId, text: reply.slice(index, index + 17) }))
    }
    bridge.onFrame(sessionId, JSON.stringify({ type: 'end', sessionId }))
    const text = spoken.join(' ')
    if (/client|await|console|import/u.test(text)) {
    }
    check(!/client|await|console|region|import|sdk|ap-east/u.test(text), 'no code identifier is ever spoken', JSON.stringify(text.slice(0, 160)))
    check(text.includes('接入方式其实很简单'), 'the prose before the block survives', JSON.stringify(text.slice(0, 80)))
    check(text.includes('上面这段代码做了三件事'), 'the prose after the block survives', JSON.stringify(text.slice(-60)))
    reader.enqueue = originalEnqueue
    }
  }

  // ── a table must never be spoken, however it is streamed ────────────────
  // The bug this pins: a table row is not recognisable until its closing pipe
  // arrives, so a released prefix of it ("完全不出声，") read as ordinary prose
  // and was spoken — and speech cannot be taken back. Sanitizing a settled
  // PREFIX of the text is only safe if the arriving block is withheld.
  {
    const live = globalThis.__DSH_VOICE__
    const bridge = live?.bridge
    const sessionId = 'session-table'
    live.voice.setCurrentSession(sessionId)
    const spoken = []
    const player = live.reader
    const originalEnqueue = player.enqueue.bind(player)
    player.enqueue = (texts, meta) => { spoken.push(...texts); return originalEnqueue(texts, meta) }

    // character for character the reply that leaked
    const reply = '如果听到了任何**不该念的标识符**，把具体那个词告我。\n\n---\n\n## 你可以重点听这几处\n\n'
      + '| 位置 | 预期 |\n|---|---|\n'
      + '| 三个表格 | 完全不出声，`endpoint`、`retries`、`200ms` 都不该被念 |\n'
      + '| 三段 JS 代码 | 完全不出声，`createClient`、`mergeByKey`、`console.log` 都不该被念 |\n'
      + '| `mergeByKey` 那句正文 | 行内代码要念 |\n'
      + '| 最后一句 | 念完自动停 |'
    // several chunk sizes: the boundary between a row and its pipe moves
    for (const size of [7, 13, 23, 41]) {
      spoken.length = 0
      bridge.onFrame(sessionId, JSON.stringify({ type: 'start', sessionId, attemptId: `t${String(size)}`, turn: 1 }))
      for (let index = 0; index < reply.length; index += size) {
        bridge.onFrame(sessionId, JSON.stringify({ type: 'delta', sessionId, text: reply.slice(index, index + size) }))
      }
      bridge.onFrame(sessionId, JSON.stringify({ type: 'end', sessionId }))
      const text = spoken.join(' ')
      const leaks = ['mergeByKey', 'createClient', 'endpoint', 'retries', '200ms', 'console.log'].filter((word) => text.includes(word))
      check(leaks.length === 0, `no table or code content is spoken at ${String(size)}-char deltas`, leaks.join(','))
      check(text.includes('把具体那个词告我'), `the prose before the table survives at ${String(size)}-char deltas`, JSON.stringify(text.slice(0, 60)))
      check(text.includes('你可以重点听这几处'), `the heading survives at ${String(size)}-char deltas`, JSON.stringify(text.slice(-40)))
    }
    player.enqueue = originalEnqueue
  }

  // ── the voice picker offers Chinese only, grouped ─────────────────────────
  // The engines return every language they know (Edge alone ships 322 voices)
  // and the plugin keeps just the Chinese ones. The ordering is asserted from
  // the ID, not the locale: the host reports plain `zh-CN` for the Liaoning and
  // Shaanxi voices too, so only the id carries the dialect.
  {
    const live = globalThis.__DSH_VOICE__
    // Fed straight into the bridge: the bundle resolves `fetch` against a window
    // this harness does not own, so a stub here would intercept nothing. This
    // scenario is about the picker's shape, not about the transport.
    const roster = [
      { id: 'en-US-AriaNeural', label: 'Aria', locale: 'en-US', gender: 'Female' },
      { id: 'ja-JP-NanamiNeural', label: 'Nanami', locale: 'ja-JP', gender: 'Female' },
      { id: 'zh-CN-liaoning-XiaobeiNeural', label: 'Xiaobei', locale: 'zh-CN', gender: 'Female' },
      { id: 'zh-CN-shaanxi-XiaoniNeural', label: 'Xiaoni', locale: 'zh-CN', gender: 'Female' },
      { id: 'zh-CN-XiaoxiaoNeural', label: 'Xiaoxiao', locale: 'zh-CN', gender: 'Female' },
      { id: 'zh-CN-YunxiNeural', label: 'Yunxi', locale: 'zh-CN', gender: 'Male' },
      { id: 'zh-HK-HiuGaaiNeural', label: 'HiuGaai', locale: 'zh-HK', gender: 'Female' },
      { id: 'zh-TW-HsiaoChenNeural', label: 'HsiaoChen', locale: 'zh-TW', gender: 'Female' },
      { id: 'fr-FR-DeniseNeural', label: 'Denise', locale: 'fr-FR', gender: 'Female' },
    ]
    live.bridge.voices = roster
    live.bridge.voicesEngine = 'edge'
    live.bridge.resolved = 'edge'

    const ids = live.voice.voices.map((item) => item.id)
    check(ids.length === 6, 'only Chinese voices reach the picker', ids.join(','))
    check(!ids.some((id) => id.startsWith('en-') || id.startsWith('ja-') || id.startsWith('fr-')), 'no foreign voice survives the filter', ids.join(','))
    check(live.voice.allVoiceCount === 9, 'the unfiltered count is still reported', String(live.voice.allVoiceCount))
    check(
      ids.join(',') === 'zh-CN-XiaoxiaoNeural,zh-CN-YunxiNeural,zh-CN-liaoning-XiaobeiNeural,zh-CN-shaanxi-XiaoniNeural,zh-TW-HsiaoChenNeural,zh-HK-HiuGaaiNeural',
      'the standard voices come before the dialect ones, and the groups stay together',
      ids.join(','),
    )

    const options = live.voice.voiceOptions()
    check(options.length === 6, 'one option per voice', String(options.length))
    check(
      options.filter((entry) => entry.heading !== null).map((entry) => entry.heading).join(',') === '普通话,台湾,粤语',
      'a heading opens each language group',
      options.filter((entry) => entry.heading !== null).map((entry) => entry.heading).join(','),
    )
    check(options[2].heading === null, 'a heading appears only once per group', String(options[2].heading))
    check(live.voice.voiceOptions() === options, 'the rows are computed once and reused', 'a new array each call')
    // Reloading the roster must invalidate that cache. The first version of this
    // cache returned `voiceCache.options` BEFORE the call that validates it
    // against the roster, so a reload kept serving the old list for ever.
    live.bridge.voices = [{ id: 'zh-CN-YunxiNeural', label: 'Yunxi', locale: 'zh-CN', gender: 'Male' }]
    const reloaded = live.voice.voiceOptions()
    check(reloaded !== options, 'a new roster invalidates the cached rows', 'the old array was reused')
    check(reloaded.length === 1, 'the cached rows follow the new roster', String(reloaded.length))
    live.bridge.voices = roster
    check(options.find((entry) => entry.voice.id === 'zh-CN-YunxiNeural').label === 'Yunxi · 男', 'the label carries the gender', options.find((entry) => entry.voice.id === 'zh-CN-YunxiNeural').label)
  }

  // ── the speed popup ─────────────────────────────────────────────────────
  // One trigger that expands into a list. Each scenario renders from scratch and
  // performs exactly one interaction, so no scenario can pollute another.
  {
    const consoleReg = env.registrations.find((item) => item.options.name === 'shell.overlay')
    /** Every element in a rendered tree, depth first. */
    const walk = (node, out = []) => {
      if (node === null || node === undefined || typeof node !== 'object') return out
      if (node.props !== undefined) {
        out.push(node)
        const kids = node.props.children
        for (const child of Array.isArray(kids) ? kids.flat(Infinity) : [kids]) walk(child, out)
      }
      return out
    }
    const render = () => {
      const injected = consoleReg.options.inject('session-smoke')
      env.react.__begin()
      const element = consoleReg.component(injected)
      env.react.__end()
      return element
    }
    const triggerOf = (tree) => walk(tree).find((node) => node.props['aria-haspopup'] === 'listbox')
    const menuOf = (tree) => walk(tree).find((node) => node.props.role === 'listbox')
    const optionsOf = (tree) => (menuOf(tree)?.props?.children ?? []).filter(Boolean)
    const rowOf = (tree) => walk(tree).find((node) => Array.isArray(node.props.children)
      && node.props.children.flat(Infinity).some((kid) => kid?.props?.['aria-haspopup'] === 'listbox'))
    const rateOf = () => evaluate(env, 'globalThis.__DSH_VOICE__.reader.rateMultiplier')

    // collapsed: one row, no options
    const collapsed = render()
    check(triggerOf(collapsed) !== undefined, 'the console has a speed trigger')
    check(triggerOf(collapsed)?.props?.['aria-expanded'] === 'false', 'the speed menu starts collapsed')
    check(menuOf(collapsed) === undefined, 'no menu is rendered while collapsed')
    check(optionsOf(collapsed).length === 0, 'no speed option is rendered while collapsed')
    check(
      (rowOf(collapsed)?.props.children ?? []).flat(Infinity).filter((child) => child?.type === 'button').length === 1,
      'the collapsed speed control is a single button',
    )

    // expanding offers the ladder in order, exactly one marked current
    triggerOf(collapsed).props.onClick()
    const expanded = render()
    check(triggerOf(expanded)?.props?.['aria-expanded'] === 'true', 'pressing the trigger expands the menu')
    const options = optionsOf(expanded)
    check(options.length === RATE_LADDER.length, 'every speed is offered once expanded', String(options.length))
    check(
      options.map((option) => option.props.children).join(',') === RATE_LADDER.map((choice) => `${String(choice)}x`).join(','),
      'the options are the ladder, in order, with no extra copy',
      options.map((option) => option.props.children).join(','),
    )
    check(options.filter((option) => option.props['data-on'] === 'true').length === 1, 'exactly one speed is marked current')

    // SCENARIO: press an option, then its click lands (the real sequence).
    {
      const tree = render()
      const row = rowOf(tree)
      const option = optionsOf(tree).find((item) => item.props.children === '1.5x')
      const target = makeElement('button')
      // Deliberately leave the row's ref UNATTACHED: that is the real-world case
      // during React's commit, and only `composedPath()` can answer correctly.
      const rowRef = row?.props?.ref
      if (rowRef !== undefined && rowRef !== null) rowRef.current = undefined
      const rowNode = { dataset: { dshVoiceRateRow: '1' }, contains: () => true }
      env.fireDocument('click', { target, composedPath: () => [target, rowNode, env.document.body] })
      check(menuOf(render()) !== undefined, 'a press on an option keeps the menu open even before the ref is attached')
      option.props.onClick()
      check(await rateOf() === 1.5, 'the option click applies the speed', String(await rateOf()))
      // the document click that follows the option click must not undo it
      env.fireDocument('click', { target, composedPath: () => [target, rowNode, env.document.body] })
      check(await rateOf() === 1.5, 'the click that follows keeps the speed', String(await rateOf()))
      const after = render()
      check(menuOf(after) === undefined, 'choosing a speed closes the menu')
      check(triggerOf(after)?.props?.children?.[0]?.props?.children === '1.5x', 'the trigger shows the chosen speed')
    }

    // SCENARIO: an outside press dismisses
    {
      const outside = makeElement('div')
      env.fireDocument('click', { target: outside, composedPath: () => [outside, env.document.body] })
      check(menuOf(render()) === undefined, 'an outside press dismisses the menu')
    }

    // SCENARIO: Escape dismisses
    {
      triggerOf(render()).props.onClick()
      check(menuOf(render()) !== undefined, 'the menu reopens')
      env.fireDocument('keydown', { key: 'Escape' })
      check(menuOf(render()) === undefined, 'Escape dismisses the menu')
    }

    // SCENARIO: picking 2x end to end
    {
      triggerOf(render()).props.onClick()
      const target = optionsOf(render()).find((item) => item.props.children === '2x')
      target.props.onClick()
      check(await rateOf() === 2, 'picking 2x applies it', String(await rateOf()))
      check(menuOf(render()) === undefined, 'the menu is closed after picking')
    }
  }

  // ── dragging the console ────────────────────────────────────────────────
  // The whole header drags, not just the collapse arrow. A press that starts on
  // a control must be left alone, or the collapse button and the pickers stop
  // working.
  {
    const consoleReg = env.registrations.find((item) => item.options.name === 'shell.overlay')
    const walk = (node, out = []) => {
      if (node === null || node === undefined || typeof node !== 'object') return out
      if (node.props !== undefined) {
        out.push(node)
        const kids = node.props.children
        for (const child of Array.isArray(kids) ? kids.flat(Infinity) : [kids]) walk(child, out)
      }
      return out
    }

    /** A panel + head + button chain, the way the browser nests them. */
    const buildDom = () => {
      const panel = makeElement('div')
      panel.className = 'dsh-voice-console'
      panel.setAttribute('data-dsh-voice-console', '1')
      panel.style.right = '24px'
      panel.style.bottom = '96px'
      panel.getBoundingClientRect = () => ({ left: 900, top: 500, width: panel.offsetWidth, height: panel.offsetHeight })
      const head = makeElement('div')
      head.className = 'dsh-voice-head'
      const grip = makeElement('span')
      grip.className = 'dsh-voice-grip'
      // mirror the rendered attributes so a marker regression is caught
      const renderedGrip = walk(renderConsoleTree()).find((node) => node.props.className === 'dsh-voice-grip')
      for (const [key, value] of Object.entries(renderedGrip?.props ?? {})) {
        if (key === 'className' || key === 'key' || key === 'children' || key === 'ref') continue
        if (String(key).startsWith('data-')) grip.setAttribute(String(key), String(value))
      }
      const collapse = makeElement('button')
      collapse.className = 'dsh-voice-icon'
      panel.appendChild(head)
      head.appendChild(grip)
      head.appendChild(collapse)
      return { panel, head, grip, collapse }
    }

    const tree = renderConsoleTree()
    const headNode = walk(tree).find((node) => node.props.className === 'dsh-voice-head')
    check(
      walk(tree).some((node) => node.props.className === 'dsh-voice-grip'),
      'the header shows a drag grip',
    )

    /**
     * Build the real DOM chain and bind the header's native drag listener to it,
     * exactly as the effect does at runtime.
     *
     * @returns the elements plus the head's press trigger.
     */
    /** Hand the node to the header's callback ref, as React does at commit. */
    const bindDrag = (dom) => {
      if (typeof headNode.props.ref !== 'function') throw new Error('the header ref is not a callback')
      headNode.props.ref(dom.head)
      return dom
    }

    // SCENARIO: dragging the grip moves the panel and is remembered
    {
      const dom = buildDom()
      // React hands the node to the callback ref at commit time
      if (typeof headNode.props.ref === 'function') headNode.props.ref(dom.head)
      check(typeof dom.head.listeners?.get === 'function' && (dom.head.listeners.get('pointerdown') ?? []).length === 1,
        'the native drag listener is attached to the header',
        `listeners=${String((dom.head.listeners?.get?.('pointerdown') ?? []).length)}`)
      dom.head.fire('pointerdown', { button: 0, target: dom.grip, pointerId: 1, clientX: 1000, clientY: 520, preventDefault() {} })
      env.fireWindow('pointermove', { clientX: 1030, clientY: 560 })
      check(dom.panel.style.left === '930px', 'dragging pins the panel by left', String(dom.panel.style.left))
      check(dom.panel.style.top === '540px', 'dragging pins the panel by top', String(dom.panel.style.top))
      check(dom.panel.style.right === 'auto', 'the old right anchor is released', String(dom.panel.style.right))
      check(dom.panel.style.bottom === 'auto', 'the old bottom anchor is released', String(dom.panel.style.bottom))
      env.fireWindow('pointerup', {})
      check(JSON.parse(env.window.localStorage.getItem('dsh-voice.console-position')).left === '930px', 'the dragged position is persisted')
    }

    // SCENARIO: the grip dots are themselves a drag handle
    {
      const dom = bindDrag(buildDom())
      // the grip must not carry the "do not drag" marker
      check(
        dom.grip.getAttribute('data-dsh-voice-no-drag') === null,
        'the grip is not excluded from dragging',
        String(dom.grip.getAttribute('data-dsh-voice-no-drag')),
      )
      dom.head.fire('pointerdown', { button: 0, target: dom.grip, pointerId: 9, clientX: 1000, clientY: 520, preventDefault() {} })
      env.fireWindow('pointermove', { clientX: 1020, clientY: 545 })
      check(dom.panel.style.left === '920px', 'dragging from the grip moves the panel', String(dom.panel.style.left))
      check(dom.panel.style.top === '525px', 'dragging from the grip moves it vertically too', String(dom.panel.style.top))
      env.fireWindow('pointerup', {})
    }

    // SCENARIO: the drag stays inside the viewport
    {
      const dom = bindDrag(buildDom())
      dom.head.fire('pointerdown', { button: 0, target: dom.grip, pointerId: 2, clientX: 1000, clientY: 520, preventDefault() {} })
      env.fireWindow('pointermove', { clientX: 5000, clientY: 5000 })
      const left = Number.parseFloat(dom.panel.style.left)
      const top = Number.parseFloat(dom.panel.style.top)
      check(left <= env.window.innerWidth - dom.panel.offsetWidth, 'the drag cannot leave the right edge', String(left))
      check(top <= env.window.innerHeight - dom.panel.offsetHeight, 'the drag cannot leave the bottom edge', String(top))
      env.fireWindow('pointerup', {})
    }

    // SCENARIO: a press on a control is not a drag
    {
      const dom = bindDrag(buildDom())
      let stopped = null
      // the grip is a handle, not a control: it must NOT be in the skip list
      check(dom.grip.closest('button, select, input, a, [data-dsh-voice-no-drag]') === null, 'the grip is not a control')
      dom.head.fire('pointerdown', { button: 0, target: dom.collapse, pointerId: 3, clientX: 1000, clientY: 520, preventDefault() { stopped = 'prevented' } })
      env.fireWindow('pointermove', { clientX: 1100, clientY: 600 })
      check(dom.panel.style.left === undefined, 'a press on a control does not move the panel', String(dom.panel.style.left))
      check(stopped === null, 'a press on a control is not swallowed', String(stopped))
      env.fireWindow('pointerup', {})
    }

    // SCENARIO: the collapse arrow still collapses the panel (drag must not eat it)
    {
      const collapseReg = consoleReg
      const injected = collapseReg.options.inject('session-smoke')
      const walkTree = (node, out = []) => {
        if (node === null || node === undefined || typeof node !== 'object') return out
        if (node.props !== undefined) {
          out.push(node)
          const kids = node.props.children
          for (const child of Array.isArray(kids) ? kids.flat(Infinity) : [kids]) walkTree(child, out)
        }
        return out
      }
      env.react.__begin()
      const element = collapseReg.component(injected)
      env.react.__end()
      const collapseButton = walkTree(element).find((node) => String(node.props['aria-label'] ?? '').includes('收起'))
      check(collapseButton !== undefined, 'the collapse arrow is present')
      collapseButton.props.onClick()
      env.react.__begin()
      const collapsed = collapseReg.component(injected)
      env.react.__end()
      check(collapsed.props['data-open'] === 'false', 'the collapse arrow still collapses the console', String(collapsed.props['data-open']))
    }

    // SCENARIO: a right-click never starts a drag
    {
      const dom = bindDrag(buildDom())
      dom.head.fire('pointerdown', { button: 2, target: dom.grip, pointerId: 4, clientX: 1000, clientY: 520, preventDefault() {} })
      env.fireWindow('pointermove', { clientX: 1100, clientY: 620 })
      check(dom.panel.style.left === undefined, 'a secondary-button press does not drag', String(dom.panel.style.left))
      env.fireWindow('pointerup', {})
    }
  }

  process.stdout.write(failures.length === 0 ? '\nPASS\n' : `\nFAILED (${String(failures.length)})\n${failures.join('\n')}\n`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`smoke test crashed: ${error?.stack ?? String(error)}\n`)
  process.exit(2)
})
