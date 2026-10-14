/**
 * Speech synthesis for `dsh-voice`.
 *
 * Three engines sit behind one interface:
 *
 * - `edge`    — Microsoft Edge neural voices through the `edge-tts` CLI
 *               (natural prosody, network, no key). Produces MP3.
 * - `local`   — the operating system's own voice: macOS `say`, Windows
 *               `System.Speech`, Linux `espeak-ng` / `spd-say`. Produces WAV.
 * - `browser` — no host synthesis at all; the page uses the Web Speech API.
 *
 * Synthesised audio is written to a content-addressed cache under the DSH home
 * (`voice-cache/<sha1>.<ext>`) so replaying a message, re-reading a turn or
 * seeking backwards inside a sentence costs nothing. Durations are parsed from
 * the produced bytes (WAV headers and MPEG frame headers), because the seek
 * controls are only honest if the timeline knows how long every segment is.
 *
 * @module dsh-voice/engines
 */

import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Default Edge voice: Mandarin female, the closest match to KIMI's reader. */
const DEFAULT_EDGE_VOICE = 'zh-CN-XiaoxiaoNeural'

/** Default macOS `say` voice (Mandarin, Simplified Chinese). */
const DEFAULT_MAC_VOICE = 'Tingting'

/**
 * How a missing engine is explained.
 *
 * Shared between the synthesis path (which throws) and
 * {@link engineMessage} (which reports it as text), so a user who hits either
 * route reads the same sentence — including the install command.
 */
const EDGE_MISSING = 'edge-tts was not found; install it with `python3 -m pip install --user edge-tts`'
const LOCAL_MISSING = 'no operating-system speech command was found (macOS `say`, Windows PowerShell, or espeak-ng)'

/** Cache index rebuild / prune cadence (writes between prunes). */
const PRUNE_EVERY = 24

/** Synthesis timeout: a long sentence on a slow link still finishes. */
const SYNTH_TIMEOUT_MS = 45000

/** Look up one executable on PATH, returning its absolute path or undefined. */
function which(command) {
  try {
    const out = execFileSync('/usr/bin/env', ['sh', '-c', `command -v ${command}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const path = out.trim().split('\n')[0]
    return path === '' ? undefined : path
  } catch {
    return undefined
  }
}

/** Run one command and resolve with its stdout, rejecting on failure. */
function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      timeout: SYNTH_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = String(stderr ?? '').trim().split('\n').slice(-3).join(' ')
        const failure = new Error(detail === '' ? error.message : detail)
        failure.code = error.code
        reject(failure)
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })
}

/** Wrap raw little-endian PCM in a 44-byte RIFF/WAVE header so a page can decode it. */
export function wavFromPcm(pcm, sampleRate, channels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44)
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * Duration in seconds of one encoded audio buffer.
 *
 * WAV reads its `fmt `/`data` chunks; MP3 walks the frame headers (a VBR file
 * is summed frame by frame), which is what `edge-tts` produces. Anything
 * unparseable returns `null` and the page falls back to the media element's
 * own duration.
 *
 * @param buffer - the encoded audio.
 * @param mime - the declared MIME type (a hint only; the bytes decide).
 * @returns seconds, or null when the format is not understood.
 */
export function audioDuration(buffer, mime = '') {
  if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') {
    return wavDuration(buffer)
  }
  if (buffer.length > 4 && (buffer.toString('ascii', 0, 3) === 'ID3' || looksLikeMpeg(buffer))) {
    return mpegDuration(buffer)
  }
  if (mime === 'audio/wav') return wavDuration(buffer)
  if (mime === 'audio/mpeg') return mpegDuration(buffer)
  return null
}

/** Read one WAVE buffer's duration from its chunk list. */
function wavDuration(buffer) {
  let offset = 12
  let byteRate = 0
  let dataBytes = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'fmt ' && offset + 8 + 16 <= buffer.length) {
      byteRate = buffer.readUInt32LE(offset + 8 + 8)
    } else if (id === 'data') {
      dataBytes = Math.min(size, buffer.length - offset - 8)
    }
    offset += 8 + size + (size % 2)
  }
  if (byteRate <= 0 || dataBytes <= 0) return null
  return dataBytes / byteRate
}

/** True when a byte pair looks like an MPEG audio frame sync. */
function looksLikeMpeg(buffer) {
  for (let i = 0; i + 2 < Math.min(buffer.length, 8192); i += 1) {
    if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) return true
  }
  return false
}

/** MPEG audio frame tables: bitrate (kbps) and sample rate (Hz) by version/layer. */
const MPEG_BITRATES = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
const MPEG_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] }

/** Sum every MPEG frame's duration, skipping a leading ID3v2 tag. */
function mpegDuration(buffer) {
  let offset = 0
  if (buffer.toString('ascii', 0, 3) === 'ID3' && buffer.length > 10) {
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f)
    offset = 10 + size
  }
  let seconds = 0
  let frames = 0
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1
      continue
    }
    const versionBits = (buffer[offset + 1] >> 3) & 0x03
    const layerBits = (buffer[offset + 1] >> 1) & 0x03
    const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f
    const rateIndex = (buffer[offset + 2] >> 2) & 0x03
    const padding = (buffer[offset + 2] >> 1) & 0x01
    if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      offset += 1
      continue
    }
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25
    const layer = 4 - layerBits
    const bitrate = (MPEG_BITRATES[`${version === 25 ? 2 : version}-${layer}`] ?? [])[bitrateIndex]
    const sampleRate = (MPEG_RATES[version] ?? [])[rateIndex]
    if (bitrate === undefined || sampleRate === undefined || bitrate === 0) {
      offset += 1
      continue
    }
    const samples = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576
    const frameLength = layer === 1
      ? Math.floor((12 * bitrate * 1000) / sampleRate + padding) * 4
      : Math.floor((samples / 8 * bitrate * 1000) / sampleRate) + padding
    if (frameLength <= 4) {
      offset += 1
      continue
    }
    seconds += samples / sampleRate
    frames += 1
    offset += frameLength
  }
  return frames === 0 ? null : seconds
}

/** One synthesised utterance as the routes hand it back. */
export class VoiceEngines {
  /** @type {Map<string, { bytes: number, at: number }>} */
  #index = new Map()
  #indexed = false
  #writesSincePrune = 0
  /** @type {Promise<object[]> | undefined} */
  #edgeVoices
  /** @type {Promise<object[]> | undefined} */
  #localVoices

  /**
   * @param ctx - host plugin context (subprocess-free: this uses node:child_process directly).
   * @param store - the live config snapshot.
   */
  constructor(ctx, store) {
    this.ctx = ctx
    this.store = store
    this.cacheDir = join(dshHome(), 'voice-cache')
    this.tools = detectTools()
  }

  /** The detected toolchain, for the status payload. */
  capabilities() {
    return {
      platform: platform(),
      edge: this.tools.edgeTts !== undefined ? { command: this.tools.edgeTts, python: this.tools.python } : null,
      local: this.tools.localCommand !== undefined ? { command: this.tools.localCommand } : null,
      edgeVoicesCached: this.#edgeVoices !== undefined,
    }
  }

  /** Resolve the effective engine for the current config. */
  resolvedEngine() {
    return resolveEngine(this.store.get().engine, this.tools)
  }

  /** The voice the next synthesis will use for one engine. */
  voiceFor(engine) {
    const configured = this.store.get().voice.trim()
    if (configured !== '') return configured
    const resolved = engine ?? this.resolvedEngine()
    if (resolved === 'edge') return DEFAULT_EDGE_VOICE
    if (resolved === 'local') return this.tools.localDefaultVoice ?? ''
    return ''
  }

  /**
   * Synthesise one text into encoded audio.
   *
   * @param text - the text to speak (already sanitized by the caller).
   * @param overrides - per-request `engine` / `voice` / `rate`.
   * @returns `{ bytes, mime, duration, engine, voice, rate, cached }`.
   */
  async synthesize(text, overrides = {}) {
    const config = this.store.get()
    // `auto` is a POLICY, never an engine. Passing it through would put the
    // literal string "auto" into the cache key, so a later switch from the OS
    // voice to Edge kept hitting the entry the OS voice produced — every voice
    // choice then replayed one stale file.
    const engine = resolveEngine(overrides.engine ?? config.engine, this.tools)
    if (engine === 'browser') {
      const error = new Error('the browser engine synthesises in the page')
      error.code = 'engine-browser'
      throw error
    }
    if (engine === 'unavailable') {
      const error = new Error(engineMessage(this.tools, config.engine))
      error.code = 'engine-unavailable'
      throw error
    }
    const voice = overrides.voice ?? this.voiceFor(engine)
    const notice = await this.#voiceNotice(engine, voice)
    const rate = clampInt(overrides.rate ?? config.rate, -50, 50, 0)
    const key = createHash('sha1').update(`${engine}\u0000${voice}\u0000${rate}\u0000${text}`).digest('hex')

    const hit = this.#readCache(key)
    if (hit !== undefined) return { ...hit, engine, voice, rate, cached: true, notice }

    const produced = engine === 'edge'
      ? await this.#synthesizeEdge(text, voice, rate)
      : await this.#synthesizeLocal(text, voice, rate)
    const duration = audioDuration(produced.bytes, produced.mime)
    this.#writeCache(key, produced.bytes, produced.ext, { mime: produced.mime, duration })
    return { ...produced, duration, engine, voice, rate, cached: false, notice }
  }

  /**
   * Whether the requested voice is one the engine actually knows.
   *
   * This exists because of one measured trap: macOS `say -v <unknown>` exits 0
   * and speaks with the system default voice, so five different voice choices
   * produced five byte-identical files while every log line claimed a different
   * voice. A silent substitution is worse than a refusal, so the caller is told.
   *
   * @param engine - the resolved engine.
   * @param voice - the voice about to be requested.
   * @returns a human note when the voice cannot be honoured, else ''.
   */
  async voiceNotice(engine, voice) {
    return this.#voiceNotice(engine, voice)
  }

  async #voiceNotice(engine, voice) {
    if (voice === '') return ''
    if (engine === 'edge') {
      // Edge voice ids are self-describing and validated by the service; an
      // unknown one fails loudly there, so no pre-check is needed.
      return ''
    }
    if (engine !== 'local') return ''
    const roster = await this.voices('local')
    if (roster.length === 0) return ''
    if (roster.some((item) => item.id === voice)) return ''
    const sample = roster.slice(0, 3).map((item) => item.id).join(' / ')
    return `系统语音没有「${voice}」这个音色，已改用默认音色（可选：${sample} …）。请在音色列表里挑一个，或把引擎切到 edge。`
  }

  /**
   * The engine's voice roster, for the picker. Edge voices come from the CLI's
   * own list (cached for the process); local voices come from the OS.
   *
   * @param engine - the engine to enumerate.
   * @returns `{ id, label, locale, gender }[]`.
   */
  async voices(engine) {
    const resolved = engine ?? this.resolvedEngine()
    if (resolved === 'edge') return this.#edgeVoiceList()
    if (resolved === 'local') return this.#localVoiceList()
    return []
  }

  /** Read one cached segment, or undefined on a miss. */
  #readCache(key) {
    const record = this.#loadIndex().get(key)
    if (record === undefined) return undefined
    const path = join(this.cacheDir, `${key}.${record.ext}`)
    try {
      const bytes = readFileSync(path)
      record.at = Date.now()
      return { bytes, mime: record.mime, ext: record.ext, duration: record.duration ?? null }
    } catch {
      this.#index.delete(key)
      return undefined
    }
  }

  /** Write one segment and prune the cache when due. */
  #writeCache(key, bytes, ext, meta) {
    try {
      mkdirSync(this.cacheDir, { recursive: true })
      const path = join(this.cacheDir, `${key}.${ext}`)
      writeFileSync(path, bytes)
      this.#loadIndex().set(key, { bytes: bytes.length, ext, mime: meta.mime, duration: meta.duration, at: Date.now() })
      this.#writesSincePrune += 1
      if (this.#writesSincePrune >= PRUNE_EVERY) {
        this.#writesSincePrune = 0
        this.#prune()
      }
    } catch (error) {
      this.ctx.logger?.warn?.('dsh-voice: cannot cache audio: %s', error?.message ?? error)
    }
  }

  /** Build the in-memory index once from the cache directory. */
  #loadIndex() {
    if (this.#indexed) return this.#index
    this.#indexed = true
    try {
      mkdirSync(this.cacheDir, { recursive: true })
      for (const entry of readdirSync(this.cacheDir)) {
        const match = /^([0-9a-f]{40})\.([a-z0-9]+)$/.exec(entry)
        if (match === null) continue
        try {
          const stat = statSync(join(this.cacheDir, entry))
          this.#index.set(match[1], { bytes: stat.size, ext: match[2], mime: mimeForExt(match[2]), duration: null, at: stat.mtimeMs })
        } catch { /* an unreadable entry is simply not indexed */ }
      }
    } catch { /* an absent cache directory is not an error */ }
    return this.#index
  }

  /** Drop least-recently-used segments until the byte ceiling holds. */
  #prune() {
    const limit = this.store.get().maxCacheBytes
    const entries = [...this.#index.entries()].sort((left, right) => left[1].at - right[1].at)
    let total = entries.reduce((sum, [, value]) => sum + value.bytes, 0)
    for (const [key, value] of entries) {
      if (total <= limit) break
      try {
        unlinkSync(join(this.cacheDir, `${key}.${value.ext}`))
      } catch { /* already gone */ }
      this.#index.delete(key)
      total -= value.bytes
    }
  }

  /** macOS `say` / Windows SAPI / Linux espeak-ng, all normalised to WAV or MP3. */
  async #synthesizeLocal(text, voice, rate) {
    const tools = this.tools
    if (tools.localCommand === undefined) {
      const error = new Error(LOCAL_MISSING)
      error.code = 'engine-unavailable'
      throw error
    }
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const out = join(tmpdir(), `dsh-voice-${stamp}.${tools.localExt}`)
    try {
      if (tools.localKind === 'say') {
        const args = []
        if (voice !== '') args.push('-v', voice)
        // `say` maps a percentage offset onto its own word-per-minute scale.
        const wpm = clampInt(Math.round(200 * (1 + rate / 100)), 80, 600, 200)
        args.push('-r', String(wpm), '-o', out, '--data-format=LEI16@22050', text)
        await run(tools.localCommand, args)
      } else if (tools.localKind === 'sapi') {
        const script = [
          'Add-Type -AssemblyName System.Speech',
          '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
          voice === '' ? '' : `$s.SelectVoice(${psQuote(voice)})`,
          `$s.Rate = ${clampInt(Math.round(rate / 10), -10, 10, 0)}`,
          `$s.SetOutputToWaveFile(${psQuote(out)})`,
          `$s.Speak(${psQuote(text)})`,
          '$s.Dispose()',
        ].filter((line) => line !== '').join('; ')
        await run(tools.localCommand, ['-NoProfile', '-NonInteractive', '-Command', script])
      } else if (tools.localKind === 'espeak') {
        const args = ['-w', out]
        if (voice !== '') args.push('-v', voice)
        args.push('-s', String(clampInt(Math.round(175 * (1 + rate / 100)), 80, 450, 175)), text)
        await run(tools.localCommand, args)
      } else {
        const error = new Error(`unsupported local speech command: ${tools.localCommand}`)
        error.code = 'engine-unavailable'
        throw error
      }
      const bytes = readFileSync(out)
      return { bytes, mime: mimeForExt(tools.localExt), ext: tools.localExt }
    } finally {
      try {
        unlinkSync(out)
      } catch { /* the command may have failed before writing */ }
    }
  }

  /** `edge-tts --write-media <file> --text <text>`. */
  async #synthesizeEdge(text, voice, rate) {
    const tools = this.tools
    if (tools.edgeTts === undefined) {
      const error = new Error(EDGE_MISSING)
      error.code = 'engine-unavailable'
      throw error
    }
    const out = join(tmpdir(), `dsh-voice-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`)
    const sign = rate >= 0 ? '+' : ''
    const args = [
      '--voice', voice === '' ? DEFAULT_EDGE_VOICE : voice,
      // `--rate=-25%` as ONE argument: argparse reads `-25%` as an option name
      // when it arrives as a separate argv entry, so a slow rate used to fail
      // with "expected one argument".
      `--rate=${sign}${rate}%`,
      '--text', text,
      '--write-media', out,
    ]
    try {
      if (tools.python !== undefined) {
        await run(tools.python, ['-m', 'edge_tts', ...args])
      } else {
        await run(tools.edgeTts, args)
      }
      const bytes = readFileSync(out)
      if (bytes.length === 0) {
        const error = new Error('edge-tts produced no audio')
        error.code = 'engine-failed'
        throw error
      }
      return { bytes, mime: 'audio/mpeg', ext: 'mp3' }
    } finally {
      try {
        unlinkSync(out)
      } catch { /* the command may have failed before writing */ }
    }
  }

  /** Enumerate Edge voices once per process. */
  #edgeVoiceList() {
    if (this.#edgeVoices !== undefined) return this.#edgeVoices
    this.#edgeVoices = (async () => {
      const tools = this.tools
      if (tools.edgeTts === undefined) return []
      try {
        const { stdout } = tools.python !== undefined
          ? await run(tools.python, ['-m', 'edge_tts', '--list-voices'])
          : await run(tools.edgeTts, ['--list-voices'])
        return parseEdgeVoices(stdout)
          .sort((left, right) => localeRank(left.locale) - localeRank(right.locale) || left.label.localeCompare(right.label))
      } catch (error) {
        this.ctx.logger?.warn?.('dsh-voice: cannot list edge voices: %s', error?.message ?? error)
        this.#edgeVoices = undefined
        return []
      }
    })()
    return this.#edgeVoices
  }

  /** Enumerate the operating system's voices. */
  #localVoiceList() {
    if (this.#localVoices !== undefined) return this.#localVoices
    this.#localVoices = (async () => {
      const tools = this.tools
      try {
        if (tools.localKind === 'say') {
          const { stdout } = await run(tools.localCommand, ['-v', '?'])
          return stdout
            .split('\n')
            .map((line) => /^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s+#/u.exec(line))
            .filter((match) => match !== null)
            .map((match) => ({
              id: match[1].trim(),
              label: match[1].trim(),
              locale: match[2].replace('_', '-'),
              gender: '',
            }))
            .sort((left, right) => localeRank(left.locale) - localeRank(right.locale) || left.label.localeCompare(right.label))
        }
        if (tools.localKind === 'sapi') {
          const script = 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $i=$_.VoiceInfo; "$($i.Name)|$($i.Culture)" }'
          const { stdout } = await run(tools.localCommand, ['-NoProfile', '-NonInteractive', '-Command', script])
          return stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.includes('|'))
            .map((line) => {
              const [id, locale] = line.split('|')
              return { id, label: id, locale: locale ?? '', gender: '' }
            })
        }
        if (tools.localKind === 'espeak') {
          const { stdout } = await run(tools.localCommand, ['--voices'])
          return stdout
            .split('\n')
            .slice(1)
            .map((line) => line.trim().split(/\s+/))
            .filter((parts) => parts.length >= 4)
            .map((parts) => ({ id: parts[3], label: `${parts[3]} (${parts[1]})`, locale: parts[1] ?? '', gender: parts[2] ?? '' }))
        }
      } catch (error) {
        this.ctx.logger?.warn?.('dsh-voice: cannot list local voices: %s', error?.message ?? error)
        this.#localVoices = undefined
      }
      return []
    })()
    return this.#localVoices
  }
}

/**
 * Resolve a configured engine value into the engine that will actually speak.
 *
 * The distinction matters beyond control flow: the resolved name is part of the
 * synthesis cache key, so a policy value leaking into it makes two different
 * engines share one cache entry.
 *
 * @param requested - `auto` | `edge` | `local` | `browser`.
 * @param tools - the detected toolchain.
 * @returns `edge` | `local` | `browser` | `unavailable`.
 */
export function resolveEngine(requested, tools) {
  if (requested === 'edge') return tools.edgeTts === undefined ? 'unavailable' : 'edge'
  if (requested === 'local') return tools.localCommand === undefined ? 'unavailable' : 'local'
  if (requested === 'browser') return 'browser'
  if (tools.edgeTts !== undefined) return 'edge'
  if (tools.localCommand !== undefined) return 'local'
  return 'browser'
}

/** Resolve the DSH home the same way the harness does. */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured !== '') return configured
  return join(homedir(), '.dsh')
}

/**
 * Parse `edge-tts --list-voices` output.
 *
 * The CLI prints a fixed-width table (its `--list-voices` is not JSON), so the
 * columns are read positionally: name, gender, and the locale encoded in the
 * name's own prefix. A Python `edge_tts.list_voices()` JSON payload is accepted
 * too, because newer releases changed the CLI's output format.
 *
 * @param stdout - the command's standard output.
 * @returns normalized voice rows.
 */
function parseEdgeVoices(stdout) {
  const text = String(stdout ?? '').trim()
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      const list = Array.isArray(parsed) ? parsed : [parsed]
      return list
        .filter((item) => typeof item?.ShortName === 'string')
        .map((item) => ({
          id: item.ShortName,
          label: String(item.FriendlyName ?? item.ShortName).replace(/^Microsoft\s+/u, '').replace(/\s+Online.*$/u, ''),
          locale: String(item.Locale ?? ''),
          gender: String(item.Gender ?? ''),
        }))
    } catch { /* fall through to the table parser */ }
  }
  const rows = []
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z]{2,3}-[A-Za-z0-9-]+Neural)\s+(Female|Male)\b/u.exec(line.trim())
    if (match === null) continue
    const id = match[1]
    const parts = id.split('-')
    const locale = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : ''
    const short = (parts[parts.length - 1] ?? id).replace(/Neural$/u, '').replace(/Multilingual$/u, '')
    rows.push({ id, label: short, locale, gender: match[2] })
  }
  return rows
}

/** Order Chinese locales first, then English, then the rest. */
function localeRank(locale) {
  if (locale.startsWith('zh')) return 0
  if (locale.startsWith('en')) return 1
  return 2
}

/** The MIME type for one cache extension. */
function mimeForExt(ext) {
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'wav') return 'audio/wav'
  if (ext === 'm4a') return 'audio/mp4'
  if (ext === 'aiff' || ext === 'aif') return 'audio/aiff'
  return 'application/octet-stream'
}

/** Escape one string for a PowerShell single-quoted literal. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Clamp one integer into range. */
function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

/** A human explanation for an unavailable engine. */
function engineMessage(tools, requested) {
  if (requested === 'edge') return EDGE_MISSING
  if (requested === 'local') return LOCAL_MISSING
  return `no speech engine is available (platform ${platform()})`
}

/** Detect the speech toolchain once per process. */
function detectTools() {
  const os = platform()
  const python = which('python3') ?? which('python')
  const edgeTts = which('edge-tts')
  let edgeUsable = edgeTts !== undefined
  if (!edgeUsable && python !== undefined) {
    // The CLI script is not on PATH: `python3 -m edge_tts` still works.
    try {
      execFileSync(python, ['-c', 'import edge_tts'], { stdio: 'ignore', timeout: 10000 })
      edgeUsable = true
    } catch { /* not installed */ }
  }
  const tools = {
    python: python,
    edgeTts: edgeUsable ? (edgeTts ?? python) : undefined,
    localCommand: undefined,
    localKind: undefined,
    localExt: 'wav',
    localDefaultVoice: undefined,
  }
  if (os === 'darwin') {
    const say = which('say') ?? (existsSync('/usr/bin/say') ? '/usr/bin/say' : undefined)
    if (say !== undefined) {
      tools.localCommand = say
      tools.localKind = 'say'
      tools.localExt = 'wav'
      tools.localDefaultVoice = DEFAULT_MAC_VOICE
    }
  } else if (os === 'win32') {
    const powershell = which('powershell') ?? which('pwsh')
    if (powershell !== undefined) {
      tools.localCommand = powershell
      tools.localKind = 'sapi'
      tools.localExt = 'wav'
    }
  } else {
    const espeak = which('espeak-ng') ?? which('espeak')
    if (espeak !== undefined) {
      tools.localCommand = espeak
      tools.localKind = 'espeak'
      tools.localExt = 'wav'
      tools.localDefaultVoice = 'cmn'
    }
  }
  return tools
}
