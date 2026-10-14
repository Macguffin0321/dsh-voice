/**
 * The voice surfaces: the per-message speaker button and the floating
 * transport console.
 *
 * Both are plain React function components created with `createElement` — no
 * JSX and no build step — and both read the engine's status snapshot through a
 * subscription rather than React state owned elsewhere, so a segment finishing
 * in the engine repaints the console without a re-render cascade.
 *
 * @module dsh-voice/client/ui
 */

import { createElement, useCallback, useEffect, useRef, useState } from 'react'

/**
 * What the last drag attempt did.
 *
 * Reported by the diagnostic button so a drag that "does nothing" can be told
 * apart from a drag that never started: the difference is invisible from the
 * outside, and this plugin's users have no developer console to check it in.
 */
const dragTrace = { down: null, moves: 0, last: null }

// Published for the diagnostic report: the console has no developer tools.
try {
  globalThis.__DSH_VOICE_DRAG__ = dragTrace
} catch { /* a frozen global is not an error */ }

/** A readable name for an event target. */
function pressedName(target) {
  if (target === null || target === undefined) return '(无)'
  const cls = typeof target.className === 'string' ? target.className : ''
  return `${target.tagName ?? '?'}${cls === '' ? '' : `.${cls.split(' ')[0]}`}`
}


const h = (...args) => createElement(...args)
/** Subscribe to the reader's status snapshot. */
function useSnapshot(reader) {
  const [snapshot, setSnapshot] = useState(() => reader.snapshot())
  useEffect(() => {
    let current = true
    const previous = reader.onUpdate
    reader.onUpdate = (next) => {
      if (current) setSnapshot(next)
      try {
        previous?.(next)
      } catch { /* the engine's own listener is best-effort */ }
    }
    setSnapshot(reader.snapshot())
    return () => {
      current = false
      reader.onUpdate = previous
    }
  }, [reader])
  return snapshot
}
/** Format seconds as `m:ss`. */
function clock(seconds) {
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const whole = Math.floor(value)
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return `${String(minutes)}:${String(rest).padStart(2, '0')}`
}
/** The speaker glyph: filled while the reading plays, outline otherwise. */
function SpeakerIcon({ active, size = 16 }) {
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  }, [
    h('path', { key: 'body', d: 'M4 9.5h3.2L12 5.5v13l-4.8-4H4z' }),
    active
      ? h('path', { key: 'wave', d: 'M15.5 9a4.2 4.2 0 0 1 0 6M18 6.6a7.6 7.6 0 0 1 0 10.8' })
      : h('path', { key: 'wave', d: 'M15.5 9.5a3.6 3.6 0 0 1 0 5' }),
  ])
}
/** The stop glyph. */
function StopIcon({ size = 16 }) {
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    'aria-hidden': 'true',
  }, h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }))
}
/** The pause glyph. */
function PauseIcon({ size = 18 }) {
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    'aria-hidden': 'true',
  }, [
    h('rect', { key: 'a', x: 6.5, y: 5, width: 3.6, height: 14, rx: 1.4 }),
    h('rect', { key: 'b', x: 13.9, y: 5, width: 3.6, height: 14, rx: 1.4 }),
  ])
}
/** The play glyph. */
function PlayIcon({ size = 18 }) {
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    'aria-hidden': 'true',
  }, h('path', { d: 'M7.5 5.2v13.6L19 12z' }))
}
/**
 * The ±30 s glyph: a circular arrow whose head is anchored on the arc's end.
 *
 * Every coordinate is derived, not eyeballed: the arc's end point comes from the
 * same angle the head is built from, and the head's tip IS that end point with
 * the two barbs reached back off it. A hand-placed arrowhead is what made the
 * previous version look detached from its own stroke.
 *
 * @param props - `{ seconds, size }`.
 * @returns the icon element.
 */
function SeekIcon({ seconds, size = 20 }) {
  const forward = seconds > 0
  const cx = 12
  const cy = 12
  const r = 7.5
  // The arc leaves a gap on the side the arrow does NOT travel towards.
  const startAngle = forward ? -50 : -130
  const sweep = 310
  const start = onCircle(cx, cy, r, startAngle)
  const endAngle = forward ? startAngle + sweep : startAngle - sweep
  const end = onCircle(cx, cy, r, endAngle)
  // Direction of travel at the end of the arc: clockwise adds 90 degrees.
  const heading = forward ? endAngle + 90 : endAngle - 90
  const barb = 3.6
  const spread = (35 * Math.PI) / 180
  const radians = (heading * Math.PI) / 180
  const barbA = {
    x: end.x - Math.cos(radians - spread) * barb,
    y: end.y - Math.sin(radians - spread) * barb,
  }
  const barbB = {
    x: end.x - Math.cos(radians + spread) * barb,
    y: end.y - Math.sin(radians + spread) * barb,
  }
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  }, [
    h('path', {
      key: 'arc',
      d: `M ${trim(start.x)} ${trim(start.y)} A ${String(r)} ${String(r)} 0 1 ${forward ? 1 : 0} ${trim(end.x)} ${trim(end.y)}`,
    }),
    h('path', {
      key: 'head',
      // The head's vertex sits exactly on the arc's end, so the two strokes meet.
      d: `M ${trim(barbA.x)} ${trim(barbA.y)} L ${trim(end.x)} ${trim(end.y)} L ${trim(barbB.x)} ${trim(barbB.y)}`,
    }),
    h('text', {
      key: 'label',
      x: 12,
      y: 15.1,
      textAnchor: 'middle',
      fontSize: 8.6,
      fontWeight: 600,
      fill: 'currentColor',
      stroke: 'none',
    }, String(Math.abs(seconds))),
  ])
}
/** One point on a circle, in degrees measured from 3 o'clock. */
function onCircle(cx, cy, r, degrees) {
  const radians = (degrees * Math.PI) / 180
  return { x: cx + Math.cos(radians) * r, y: cy + Math.sin(radians) * r }
}
/** Trim a coordinate to two decimals so the markup stays readable. */
function trim(value) {
  return Math.round(value * 100) / 100
}
/**
 * The per-message speaker button.
 *
 * One press reads the message (settled text when the turn is finished, the
 * live turn otherwise); a second press stops it. The button reports its
 * session so the console and the live transport follow the conversation the
 * reader is actually looking at.
 *
 * @param props - slot props plus the injected `voice` face.
 * @returns the button element.
 */
function SpeakerButton(props) {
  const { voice, sessionId, messageId, turn } = props
  const snapshot = useSnapshot(voice.reader)
  const [busy, setBusy] = useState(false)
  const mine = snapshot.sessionId !== '' && snapshot.sessionId === sessionId
  const active = mine && (snapshot.playing || snapshot.phase === 'buffering')
  const onClick = async (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      await voice.toggleMessage({ sessionId, messageId, turn })
    } finally {
      setBusy(false)
    }
  }
  const label = active ? '停止朗读这条回复' : '朗读这条回复'
  return h('button', {
    type: 'button',
    className: 'dsh-voice-action',
    'data-dsh-voice-action': '1',
    'data-active': active ? 'true' : 'false',
    'aria-label': label,
    title: label,
    disabled: busy,
    onClick,
  }, h(SpeakerIcon, { active, size: 15 }))
}
/**
 * The invisible session probe: it reports which session the open conversation
 * belongs to, so the live transport follows the visible one.
 *
 * @param props - slot props plus the injected `voice` face.
 * @returns null (it renders nothing).
 */
function SessionProbe(props) {
  const { voice, sessionId } = props
  useEffect(() => {
    voice.setCurrentSession(sessionId)
    return () => { voice.releaseCurrentSession(sessionId) }
  }, [sessionId])
  return null
}
/**
 * The floating transport console.
 *
 * It is draggable by its header, persists its position, and collapses to a
 * compact pill. Every control drives the shared reader, so a message button,
 * the console and the live stream all operate one timeline.
 *
 * @param props - `{ voice }`.
 * @returns the console element or null when the loop is off.
 */
function VoiceConsole(props) {
  const { voice } = props
  const reader = voice.reader
  const snapshot = useSnapshot(reader)
  const [, forceVoices] = useState(0)
  const [open, setOpen] = useState(true)
  const [rateOpen, setRateOpen] = useState(false)
  const buttonRef = useRef(null)
  const rateRef = useRef(null)
/** Removes the native drag listener bound by {@link attachDrag}. */
  const detachDrag = useRef(null)
  // A popup that only closes from its own trigger is a trap, so it also closes
  // on an outside press and on Escape — like every other menu in the shell.
  //
  // Two details make this reliable, and both were learned the hard way:
  //  * the press is judged by the event's own `composedPath()`, never by a ref.
  //    A ref answers "is the row mounted right now", which is false in the
  //    middle of the commit that is mounting it, and a popup that mis-reads its
  //    own trigger as "outside" destroys the option before its click lands —
  //    the choice then does nothing at all.
  //  * it listens on the BUBBLE phase, so an option's own activation is handled
  //    before the dismisser looks at the event.
  useEffect(() => {
    if (!rateOpen) return undefined
    const onDocumentClick = (event) => {
      // The event's own path is authoritative: it names the nodes the press
      // actually travelled through, which is true even while the row is being
      // committed. A ref would answer with whatever is attached at this instant.
      const path = typeof event.composedPath === 'function' ? event.composedPath() : []
      if (path.some((node) => node !== null && node !== undefined && node.dataset?.dshVoiceRateRow !== undefined)) return
      if (path.includes(rateRef.current) && rateRef.current !== undefined && rateRef.current !== null) return
      const root = rateRef.current
      if (root !== null && root !== undefined && typeof root.contains === 'function' && root.contains(event.target)) return
      setRateOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setRateOpen(false)
    }
    document.addEventListener('click', onDocumentClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('click', onDocumentClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [rateOpen])
  useEffect(() => () => {
    detachDrag.current?.()
    detachDrag.current = null
  }, [])
  useEffect(() => {
    const off = voice.on('voices', () => { forceVoices((value) => value + 1) })
    const offStatus = voice.on('status', () => { forceVoices((value) => value + 1) })
    return () => {
      off()
      offStatus()
    }
  }, [voice])
  const position = Math.min(snapshot.position, Math.max(snapshot.duration, snapshot.position))
  const announced = voice.announcedMessage
  const status = statusLabel(snapshot, voice)
  const truncated = typeof voice.truncated === 'function' ? voice.truncated() === true : false
  const health = voice.health ?? null
  const healthOk = health === null ? null : health.reachable === true
  // Re-reading needs something queued, or a settled message on the visible
  // session — that fallback is the common case on a fresh page.
  const canReread = typeof voice.canReread === 'function' ? voice.canReread() === true : snapshot.hasReading
  const canSeek = voice.settings.engine !== 'browser'
  /**
   * Attach the window drag to the DOM itself.
   *
   * This is a native listener rather than React's `onPointerDown` prop: the
   * console lives in a slot rendered by another package, and the drag has to
   * work even when a synthetic pointer event never reaches the prop. A native
   * listener also sees the real target, so a press on a control inside the
   * header is left alone and the collapse button and pickers keep working.
   *
   * It is bound from a CALLBACK REF, not from an effect. An effect runs once per
   * dependency change, so an effect that found the node still unset would never
   * try again — the callback fires exactly when the node arrives.
   */
  const attachDrag = useCallback((head) => {
    detachDrag.current?.()
    detachDrag.current = null
    if (head === null || head === undefined) return
    /** Begin one drag. */
    const onDown = (event) => {
      dragTrace.down = { at: Date.now(), target: pressedName(event.target), button: event.button }
      if (event.button !== undefined && event.button !== 0) {
        dragTrace.down.skipped = '非左键'
        return
      }
      const pressed = event.target
      // Interactive controls keep their own behaviour; everything else in the
      // header drags, including the grip dots.
      if (pressed !== null && pressed !== undefined && typeof pressed.closest === 'function'
        && pressed.closest('button, select, input, a, [data-dsh-voice-no-drag]') !== null) {
        dragTrace.down.skipped = '按在控件上'
        return
      }
      const panel = head.closest('[data-dsh-voice-console]') ?? head.parentElement?.closest?.('[data-dsh-voice-console]')
      if (panel === null || panel === undefined) {
        dragTrace.down.skipped = '找不到面板'
        return
      }
      event.preventDefault()
      try {
        head.setPointerCapture?.(event.pointerId)
      } catch { /* capture is a nicety, not a requirement */ }
      const rect = panel.getBoundingClientRect()
      const originLeft = rect.left
      const originTop = rect.top
      const width = panel.offsetWidth
      const height = panel.offsetHeight
      const startX = event.clientX
      const startY = event.clientY
      panel.dataset.dshVoiceDragging = '1'
      head.dataset.dragging = 'true'
      /** Move the panel with the pointer, inside the viewport. */
      const onMove = (moveEvent) => {
        dragTrace.moves += 1
        const left = clamp(originLeft + moveEvent.clientX - startX, 4, Math.max(4, window.innerWidth - width - 4))
        const top = clamp(originTop + moveEvent.clientY - startY, 4, Math.max(4, window.innerHeight - height - 4))
        dragTrace.last = { dx: Math.round(moveEvent.clientX - startX), dy: Math.round(moveEvent.clientY - startY), left, top, width, height, viewport: `${String(window.innerWidth)}x${String(window.innerHeight)}` }
        // Pin the panel on the first move: a `right`/`bottom` anchor would
        // otherwise fight the new `left`/`top` and make the panel jump.
        if (panel.style.right !== 'auto') {
          panel.style.right = 'auto'
          panel.style.bottom = 'auto'
        }
        panel.style.left = `${String(left)}px`
        panel.style.top = `${String(top)}px`
      }
      /** End the drag and remember where it landed. */
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        delete panel.dataset.dshVoiceDragging
        delete head.dataset.dragging
        try {
          head.releasePointerCapture?.(event.pointerId)
        } catch { /* nothing to release */ }
        if (panel.style.left !== '') voice.savePosition({ left: panel.style.left, top: panel.style.top })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    }
    head.addEventListener('pointerdown', onDown)
    detachDrag.current = () => { head.removeEventListener('pointerdown', onDown) }
  }, [voice])
  if (!voice.enabled()) return null
  const stop = () => {
    reader.reset()
    voice.announce('已停止朗读')
  }
  const children = [
    h('div', {
      key: 'head',
      className: 'dsh-voice-head',
      ref: attachDrag,
      title: '按住拖动',
    }, [
      h('span', { key: 'grip', className: 'dsh-voice-grip', 'aria-hidden': 'true' }),
      h('span', { key: 'title', className: 'dsh-voice-title' }, [
        h('span', { key: 'dot', className: 'dsh-voice-dot', 'data-on': snapshot.playing ? 'true' : 'false' }),
        '语音播报',
      ]),
      h('span', { key: 'status', className: 'dsh-voice-status', title: status.tip }, status.text),
      h('span', {
        key: 'voice-chip',
        className: 'dsh-voice-voicechip',
        title: snapshot.voice === '' ? '使用引擎默认音色' : `当前音色：${snapshot.voice}`,
      }, snapshot.voice === '' ? '默认音色' : shortVoice(snapshot.voice)),
      h('button', {
        key: 'collapse',
        type: 'button',
        className: 'dsh-voice-icon',
        'aria-label': open ? '收起语音控制台' : '展开语音控制台',
        title: open ? '收起' : '展开',
        onClick: () => { setOpen((value) => !value) },
      }, open ? '▾' : '▸'),
    ]),
    // Edge being down is the failure that looks like nothing happening: the
    // reply arrives, the console says it is buffering, and no sound ever comes.
    // The reason is shown rather than left to be inferred.
    health !== null && health.reachable !== true
      ? h('div', {
        key: 'health',
        className: 'dsh-voice-health',
        title: '点「同步」重新检查；此提示在 Edge 恢复后自动消失',
      }, `⚠ Edge 合成服务不可用：${health.message === '' ? '原因未知' : health.message}`)
      : null,
    // A turn that stopped mid-sentence is announced. Spoken, it sounds exactly
    // like audio the listener missed, so silence is not an acceptable answer.
    truncated
      ? h('div', {
        key: 'truncated',
        className: 'dsh-voice-truncated',
        title: '本轮回复没有写完（被 token 上限或中断截断），不是朗读漏掉了',
      }, '⚠ 本轮回复似乎没写完，结尾可能不完整')
      : null,
  ]
  if (open) {
    children.push(h('div', { key: 'now', className: 'dsh-voice-now' }, [
      h('div', { key: 'text', className: 'dsh-voice-text' }, [
        // The notice is never buried: every action that fails or changes a
        // setting says so here, so the console always answers a click.
        announced === '' || snapshot.playing ? null : h('div', { key: 'notice', className: 'dsh-voice-notice' }, announced),
        voice.voiceMismatch() === '' ? null : h('div', { key: 'mismatch', className: 'dsh-voice-notice dsh-voice-warn' }, voice.voiceMismatch()),
        snapshot.voiceNotice === '' ? null : h('div', { key: 'voice-notice', className: 'dsh-voice-notice dsh-voice-warn' }, snapshot.voiceNotice),
        h('div', { key: 'body' }, snapshot.text === '' ? (announced || '等待 AI 回复…') : snapshot.text),
      ]),
      h('div', { key: 'meta', className: 'dsh-voice-meta' }, [
        h('span', { key: 'clock' }, `${clock(position)} / ${clock(snapshot.duration)}`),
        snapshot.voice === '' ? null : h('span', { key: 'voice', className: 'dsh-voice-chip' }, shortVoice(snapshot.voice)),
        snapshot.fingerprint === '' ? null : h('span', {
          key: 'fingerprint',
          className: 'dsh-voice-chip',
          title: '当前播放音频的指纹（音色一变，这个值就该变）',
        }, snapshot.fingerprint),
        snapshot.engine === '' ? null : h('span', { key: 'engine', className: 'dsh-voice-chip' }, snapshot.engine),
        Math.abs((voice.currentMultiplier() ?? 1) - 1) < 0.01 ? null : h('span', { key: 'rate', className: 'dsh-voice-chip' }, `${String(voice.currentMultiplier())}x`),
        snapshot.pending > 0 ? h('span', { key: 'pending', className: 'dsh-voice-chip' }, `合成中 ${String(snapshot.pending)}`) : null,
        snapshot.errors > 0 ? h('span', { key: 'errors', className: 'dsh-voice-chip dsh-voice-chip-warn' }, `失败 ${String(snapshot.errors)}`) : null,
      ]),
    ]))
    children.push(h('input', {
      key: 'progress',
      className: 'dsh-voice-progress',
      type: 'range',
      min: 0,
      max: Math.max(snapshot.duration, 1),
      step: 0.1,
      value: position,
      disabled: !canSeek || snapshot.duration <= 0,
      'aria-label': '播放进度',
      onChange: (event) => { void reader.seekTo(Number(event.target.value)) },
    }))
    children.push(h('div', { key: 'controls', className: 'dsh-voice-controls' }, [
      h('button', {
        key: 'back',
        type: 'button',
        className: 'dsh-voice-icon',
        disabled: !canSeek,
        'aria-label': '后退 30 秒',
        title: canSeek ? '后退 30 秒' : '浏览器语音引擎不支持精确跳转',
        onClick: () => { void reader.seekBy(-30) },
      }, h(SeekIcon, { seconds: -30 })),
      h('button', {
        key: 'toggle',
        type: 'button',
        className: 'dsh-voice-icon dsh-voice-primary',
        'aria-label': snapshot.playing ? '暂停' : '播放',
        title: snapshot.playing ? '暂停' : '播放',
        onClick: () => { void reader.toggle() },
      }, snapshot.playing ? h(PauseIcon) : h(PlayIcon)),
      h('button', {
        key: 'forward',
        type: 'button',
        className: 'dsh-voice-icon',
        disabled: !canSeek,
        'aria-label': '前进 30 秒',
        title: canSeek ? '前进 30 秒' : '浏览器语音引擎不支持精确跳转',
        onClick: () => { void reader.seekBy(30) },
      }, h(SeekIcon, { seconds: 30 })),
      h('button', {
        key: 'stop',
        type: 'button',
        className: 'dsh-voice-icon',
        'aria-label': '停止朗读',
        title: '停止朗读',
        onClick: stop,
      }, h(StopIcon)),
      // Always rendered, disabled when there is nothing to re-read. Removing the
      // button entirely made it look like the feature had gone away, and it is
      // the one control whose absence is indistinguishable from a bug: every
      // other button here stays put and greys out instead.
      h('button', {
        key: 'reread',
        type: 'button',
        className: 'dsh-voice-icon dsh-voice-reread',
        disabled: !canReread,
        'aria-label': '用当前音色重读这一段',
        title: canReread ? '用当前音色重读这一段' : '还没有可重读的内容 —— 先让 AI 回复一条',
        onClick: () => { void voice.reread() },
      }, '重读'),
      h('span', { key: 'spacer', className: 'dsh-voice-spacer' }),
      h('button', {
        key: 'sync',
        type: 'button',
        className: 'dsh-voice-icon dsh-voice-sync',
        'data-ok': healthOk === null ? 'unknown' : healthOk ? 'true' : 'false',
        'aria-label': '同步 Edge-TTS 服务',
        title: '同步 Edge-TTS 服务',
        onClick: () => { void voice.syncService() },
      }, '同步'),
      h('button', {
        key: 'auto',
        type: 'button',
        className: 'dsh-voice-toggle',
        'data-on': voice.settings.autoRead ? 'true' : 'false',
        title: voice.settings.autoRead ? '关闭自动朗读' : '开启自动朗读',
        onClick: () => { void voice.setAutoRead(!voice.settings.autoRead) },
      }, voice.settings.autoRead ? '自动朗读 开' : '自动朗读 关'),
    ]))
    children.push(h('div', { key: 'voice-row', className: 'dsh-voice-row' }, [
      h('label', { key: 'label', className: 'dsh-voice-label' }, '音色'),
      h('select', {
        key: 'select',
        className: 'dsh-voice-select',
        value: voice.settings.voice,
        ref: buttonRef,
        onChange: (event) => { void voice.setVoice(event.target.value) },
      }, [
        h('option', { key: '', value: '' }, voice.defaultVoiceLabel()),
        // A disabled heading opens each language group, so the list reads as
        // three sections instead of one long run of names.
        ...voice.voiceOptions().flatMap((entry) => (entry.heading === null
          ? [h('option', { key: entry.voice.id, value: entry.voice.id }, entry.label)]
          : [
            h('option', { key: `h-${entry.heading}`, value: '', disabled: true }, `── ${entry.heading} ──`),
            h('option', { key: entry.voice.id, value: entry.voice.id }, entry.label),
          ])),
      ]),
      h('div', {
        key: 'rate-row',
        className: 'dsh-voice-row',
        'data-dsh-voice-rate-row': '1',
        ref: rateRef,
      }, [
        h('label', { key: 'rate-label', className: 'dsh-voice-label' }, '语速'),
        h('button', {
          key: 'rate-trigger',
          type: 'button',
          className: 'dsh-voice-ratetrigger',
          'aria-haspopup': 'listbox',
          'aria-expanded': rateOpen ? 'true' : 'false',
          'aria-label': `语速 ${String(voice.currentMultiplier())} 倍，点击选择`,
          title: '选择朗读倍速',
          onClick: () => { setRateOpen((value) => !value) },
        }, [
          h('span', { key: 'current' }, `${String(voice.currentMultiplier())}x`),
          h('span', { key: 'caret', className: 'dsh-voice-caret', 'data-open': rateOpen ? 'true' : 'false' }, '▾'),
        ]),
        h('span', { key: 'hint', className: 'dsh-voice-label' }, rateOpen ? '选择倍速' : ''),
      ]),
      rateOpen
        ? h('div', {
          key: 'rate-menu',
          className: 'dsh-voice-ratemenu',
          role: 'listbox',
          'aria-label': '朗读倍速',
        }, RATE_CHOICES.map((choice) => h('button', {
          key: `rate-${String(choice)}`,
          type: 'button',
          role: 'option',
          className: 'dsh-voice-rateoption',
          'data-on': Math.abs(voice.currentMultiplier() - choice) < 0.01 ? 'true' : 'false',
          'aria-selected': Math.abs(voice.currentMultiplier() - choice) < 0.01 ? 'true' : 'false',
          onClick: () => {
            setRateOpen(false)
            void voice.setRateMultiplier(choice)
          },
        }, `${String(choice)}x`)))
        : null,
      h('button', {
        key: 'diagnose',
        type: 'button',
        className: 'dsh-voice-icon',
        'aria-label': '复制诊断报告',
        title: '把语音播报的内部状态复制到剪贴板（排查用）',
        onClick: () => { void voice.diagnose() },
      }, '诊断'),
      h('button', {
        key: 'sample',
        type: 'button',
        className: 'dsh-voice-icon',
        'aria-label': '试听当前音色',
        title: '用当前音色单独播一句（每次新建播放器，排除一切缓存干扰）',
        onClick: () => { void voice.sampleVoice() },
      }, '试听'),
      h('button', {
        key: 'reload',
        type: 'button',
        className: 'dsh-voice-icon',
        'aria-label': '刷新音色列表',
        title: '刷新音色列表',
        onClick: () => { void voice.reloadVoices() },
      }, '⟳'),
    ]))
  }
  return h('div', {
    className: 'dsh-voice-console',
    'data-dsh-voice-console': '1',
    'data-open': open ? 'true' : 'false',
    style: voice.position(),
  }, children)
}
/** Clamp one number into range. */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}
/** Shorten a voice id for the chip (`zh-CN-XiaoxiaoNeural` → `Xiaoxiao`). */
function shortVoice(voice) {
  const parts = String(voice).split('-')
  const last = parts[parts.length - 1] ?? voice
  return last.replace(/Neural$/u, '')
}
/** The status line for the console header. */
function statusLabel(snapshot, voice) {
  if (!voice.hostReady) return { text: '宿主未就绪', tip: '语音服务还没有响应；检查插件是否已启用。' }
  if (snapshot.phase === 'playing') return { text: '播报中', tip: '' }
  if (snapshot.phase === 'buffering') return { text: '缓冲中', tip: '正在合成下一段语音。' }
  if (snapshot.phase === 'paused' && snapshot.size > 0) return { text: '已暂停', tip: '' }
  if (snapshot.finished && snapshot.size > 0) return { text: '已读完', tip: '' }
  return { text: '待机', tip: '' }
}

export { SessionProbe, SpeakerButton, VoiceConsole, shortVoice }
