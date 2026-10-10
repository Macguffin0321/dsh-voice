/**
 * `dsh-voice` host half: text-to-speech synthesis, the `/voice/*` HTTP routes,
 * and the live-delta websocket that feeds the browser's auto-read engine.
 *
 * The plugin owns three pieces of host state:
 *
 * - {@link VoiceEngines} — engine detection plus one synthesis call per
 *   request, writing encoded audio into a content-addressed cache on disk.
 * - {@link VoiceConfigStore} — the live settings snapshot, persisted as a
 *   profile-patch operation (append-only, with backups) and overlaid on this
 *   row's loader config.
 * - {@link LiveTextBridge} — a subscription to `agent/assistant-stream` that
 *   fans normalized text deltas out to the browser sockets watching a session.
 *
 * @module dsh-voice
 */

import z from '@deepseek-ai/schemastery'

import { VoiceEngines } from './engines.js'
import { VoiceConfigStore } from './config.js'
import { LiveTextBridge } from './live.js'
import { registerRoutes } from './routes.js'

/** Row name; matches the package name and the bundle id. */
export const name = 'dsh-voice'

/**
 * The one service this plugin reads: the host webserver that carries the
 * `/voice/*` routes.
 *
 * Cordis normalizes `inject` into a service map (an object form means
 * "service name → intercept config", so a wrapper key here would register a
 * service called `optional`). Declaring `webServer` outright is therefore the
 * only correct spelling, and a web composition always provides it.
 */
export const inject = ['webServer']

/** Loader-facing configuration. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  autoRead: z.boolean().default(true),
  readOnSettle: z.boolean().default(false),
  softChunkChars: z.number().step(1).min(20).max(400).default(40),
  maxCharsPerRequest: z.number().step(1).min(80).max(5000).default(2000),
  engine: z.union([
    z.const('auto'),
    z.const('edge'),
    z.const('local'),
    z.const('browser'),
  ]).default('auto'),
  voice: z.string().default(''),
  rate: z.number().step(1).min(-50).max(50).default(0),
  maxCacheBytes: z.number().step(1).min(4194304).max(1073741824).default(134217728),
  backupCount: z.number().step(1).min(0).max(10).default(2),
})

/**
 * Mount both halves of the plugin.
 *
 * @param ctx - host plugin context (logger, webserver routes, subprocess, sessions).
 * @param config - the row's validated loader config.
 */
export function apply(ctx, config) {
  const raw = config ?? {}
  const store = new VoiceConfigStore(ctx, raw, {
    backupCount: clampInt(raw.backupCount, 0, 10, 2),
  })
  const engines = new VoiceEngines(ctx, store)
  const live = new LiveTextBridge(ctx)

  ctx.effect(() => () => { live.dispose() }, 'dsh-voice: live bridge')

  if (ctx.get('webServer') === undefined) {
    ctx.logger?.info?.('dsh-voice: no webServer service; browser surfaces are unavailable')
    return
  }

  ctx.effect(() => registerRoutes(ctx, { store, engines, live }), 'dsh-voice: routes')
  ctx.logger?.info?.('dsh-voice: ready (engine %s)', store.get().engine)
}

/** Clamp one optional numeric config value into range. */
function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}
