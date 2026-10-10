/**
 * Live settings for `dsh-voice`.
 *
 * The row's loader config in `cordis.patch.yml` is the baseline every start
 * begins from; the settings panel writes overrides into
 * `$DSH_HOME/voice-settings.json`, which is overlaid on that baseline. Keeping
 * the two apart is deliberate: the YAML row stays the hand-authored source of
 * truth (with its comments), and a panel write never has to rewrite it or
 * parse it back.
 *
 * @module dsh-voice/config
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The config keys a panel write may change. */
export const WRITABLE_KEYS = [
  'enabled',
  'autoRead',
  'readOnSettle',
  'softChunkChars',
  'maxCharsPerRequest',
  'engine',
  'voice',
  'rate',
]

/** Accepted speech engines. */
export const ENGINES = ['auto', 'edge', 'local', 'browser']

/** Numeric bounds per key, applied on every write. */
const BOUNDS = {
  softChunkChars: [20, 400],
  maxCharsPerRequest: [80, 5000],
  rate: [-50, 50],
}

/** Boolean keys. */
const BOOLEANS = new Set(['enabled', 'autoRead', 'readOnSettle'])

/** Resolve the DSH home the same way the harness does. */
export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured !== '') return configured
  return join(homedir(), '.dsh')
}

/**
 * The live settings snapshot plus its durable override file.
 */
export class VoiceConfigStore {
  /** @type {Record<string, unknown>} */
  #values
  /** @type {Record<string, unknown>} */
  #overrides = {}
  /** @type {Set<(value: Record<string, unknown>) => void>} */
  #listeners = new Set()
  #file
  #path

  /**
   * @param ctx - host plugin context (logger only).
   * @param raw - the row's raw loader config.
   * @param options - `{ backupCount }`.
   */
  constructor(ctx, raw, options = {}) {
    this.ctx = ctx
    this.#file = join(dshHome(), 'voice-settings.json')
    this.backupCount = clampInt(options.backupCount, 0, 10, 2)
    const saved = this.#read()
    this.#overrides = saved
    this.#values = { ...raw, ...saved }
    this.#path = this.#file
  }

  /** Absolute path of the override file (reported to the panel). */
  get file() {
    return this.#path
  }

  /** The effective settings. */
  get() {
    return { ...this.#values }
  }

  /** Subscribe to settings changes. */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /**
   * Apply one partial submission: validate, merge, persist, notify.
   *
   * @param input - untrusted JSON from the panel.
   * @returns `{ settings, issues, file }` — `issues` is empty on success.
   */
  update(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { settings: this.get(), issues: ['设置必须是一个 JSON 对象。'], file: this.#path }
    }
    const issues = []
    /** @type {Record<string, unknown>} */
    const next = {}
    for (const key of WRITABLE_KEYS) {
      const value = input[key]
      if (value === undefined) continue
      if (BOOLEANS.has(key)) {
        if (typeof value !== 'boolean') {
          issues.push(`${key} 必须是布尔值。`)
          continue
        }
        next[key] = value
        continue
      }
      if (key === 'engine') {
        if (typeof value !== 'string' || !ENGINES.includes(value)) {
          issues.push(`engine 必须是 ${ENGINES.join(' | ')} 之一。`)
          continue
        }
        next[key] = value
        continue
      }
      if (key === 'voice') {
        if (typeof value !== 'string' || value.length > 200) {
          issues.push('voice 必须是不超过 200 字符的字符串。')
          continue
        }
        next[key] = value
        continue
      }
      const [min, max] = BOUNDS[key] ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push(`${key} 必须是数字。`)
        continue
      }
      next[key] = Math.max(min, Math.min(max, Math.round(value)))
    }
    if (issues.length > 0) return { settings: this.get(), issues, file: this.#path }

    this.#overrides = { ...this.#overrides, ...next }
    this.#values = { ...this.#values, ...next }
    const writeIssue = this.#write()
    if (writeIssue !== undefined) issues.push(writeIssue)
    const snapshot = this.get()
    for (const listener of this.#listeners) {
      try {
        listener(snapshot)
      } catch { /* a throwing listener never blocks the write */ }
    }
    return { settings: snapshot, issues, file: this.#path }
  }

  /** Read the override file; a malformed file is ignored, not fatal. */
  #read() {
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const clean = {}
      for (const key of WRITABLE_KEYS) {
        if (parsed[key] !== undefined) clean[key] = parsed[key]
      }
      return clean
    } catch {
      return {}
    }
  }

  /** Persist the override file atomically; returns an issue string on failure. */
  #write() {
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      const temp = `${this.#file}.tmp-${process.pid}`
      writeFileSync(temp, `${JSON.stringify(this.#overrides, null, 2)}\n`, 'utf8')
      renameSync(temp, this.#file)
      return undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger?.warn?.('dsh-voice: cannot persist settings: %s', message)
      return `设置已生效，但写入 ${this.#file} 失败：${message}`
    }
  }
}

/** Clamp one integer into range. */
function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}
