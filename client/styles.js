/**
 * The injected stylesheet for the voice surfaces.
 *
 * One `<style>` element painted once, keyed on `data-dsh-voice-*` attributes
 * rather than hashed class names, so a DSH rebuild that changes CSS-module
 * hashes cannot break the console.
 *
 * @module dsh-voice/client/styles
 */

const CSS = `
[data-dsh-voice-action] {
  /* First in the action row: the reader sits directly under the reply it
     speaks, ahead of the rating and branch controls. */
  order: -1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  opacity: 0.72;
  cursor: pointer;
  transition: opacity 120ms ease, background-color 120ms ease, color 120ms ease;
}
[data-dsh-voice-action]:hover {
  opacity: 1;
  background: color-mix(in srgb, currentColor 12%, transparent);
}
[data-dsh-voice-action][data-active='true'] {
  opacity: 1;
  color: var(--dsh-accent-color, #4d6bfe);
  background: color-mix(in srgb, currentColor 14%, transparent);
}
[data-dsh-voice-action]:disabled {
  opacity: 0.4;
  cursor: default;
}

[data-dsh-voice-console] {
  position: fixed;
  z-index: 60;
  width: 340px;
  max-width: calc(100vw - 24px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, Canvas 92%, transparent);
  backdrop-filter: blur(10px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
  color: CanvasText;
  font: 13px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  user-select: none;
}
[data-dsh-voice-console] * {
  -webkit-user-drag: none;
}
[data-dsh-voice-console][data-open='false'] {
  width: auto;
  min-width: 168px;
  padding: 6px 10px;
}

.dsh-voice-head {
  display: flex;
  align-items: center;
  gap: 7px;
  /* The whole top row is the drag target, and the title stretches so the row
     reaches the collapse button: dragging from the empty middle works too. */
  width: 100%;
  min-height: 22px;
  margin: -4px -4px 0;
  padding: 4px;
  border-radius: 8px;
  cursor: grab;
  touch-action: none;
}
.dsh-voice-head:hover {
  background: color-mix(in srgb, currentColor 7%, transparent);
}
.dsh-voice-head:active,
.dsh-voice-head[data-dragging='true'] {
  cursor: grabbing;
}
[data-dsh-voice-console][data-dragging] {
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.24);
  transition: none;
}
/* While a drag is live nothing inside should look interactive. */
[data-dsh-voice-console][data-dragging] * {
  cursor: grabbing !important;
}
/* Make the drag affordance visible: a grip the eye can find. */
.dsh-voice-grip {
  flex: none;
  width: 10px;
  height: 14px;
  opacity: 0.35;
  cursor: grab;
  background-image: radial-gradient(currentColor 1.1px, transparent 1.1px);
  background-size: 5px 5px;
  background-position: 1px 1px;
}
.dsh-voice-head:hover .dsh-voice-grip {
  opacity: 0.6;
}
.dsh-voice-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  font-weight: 600;
  font-size: 12.5px;
  white-space: nowrap;
}
.dsh-voice-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.3;
}
.dsh-voice-dot[data-on='true'] {
  opacity: 1;
  background: #2ecc71;
  box-shadow: 0 0 0 3px rgba(46, 204, 113, 0.18);
}
.dsh-voice-voicechip {
  flex: none;
  max-width: 96px;
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-voice-reread {
  min-width: 42px;
  font-size: 11.5px;
}
/* The sync button doubles as an indicator: it is the only surface that says
   whether Edge is answering, so it colours itself by that answer. */
.dsh-voice-sync[data-ok='false'] {
  color: #dc2626;
  border-color: color-mix(in srgb, #dc2626 45%, transparent);
  background: color-mix(in srgb, #dc2626 12%, transparent);
}
.dsh-voice-sync[data-ok='true'] {
  color: #16a34a;
}
.dsh-voice-health {
  margin: 5px 0 2px;
  padding: 5px 8px;
  border-radius: 7px;
  background: color-mix(in srgb, #dc2626 14%, transparent);
  color: #b91c1c;
  font-size: 11.5px;
  line-height: 1.4;
  word-break: break-word;
}
.dsh-voice-truncated {
  margin: 5px 0 2px;
  padding: 5px 8px;
  border-radius: 7px;
  background: color-mix(in srgb, #d97706 16%, transparent);
  color: #b45309;
  font-size: 11.5px;
  line-height: 1.4;
}
.dsh-voice-status {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11.5px;
  opacity: 0.62;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-voice-now {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: 8px;
  background: color-mix(in srgb, currentColor 6%, transparent);
}
.dsh-voice-text {
  max-height: 72px;
  overflow: hidden;
  font-size: 12.5px;
  line-height: 1.55;
  opacity: 0.9;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.dsh-voice-notice {
  margin-bottom: 4px;
  padding: 3px 7px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--dsh-accent-color, #4d6bfe) 14%, transparent);
  color: var(--dsh-accent-color, #4d6bfe);
  font-size: 11.5px;
  line-height: 1.4;
}
.dsh-voice-warn {
  background: color-mix(in srgb, #d9534f 14%, transparent);
  color: #d9534f;
}
.dsh-voice-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  opacity: 0.7;
}
.dsh-voice-chip {
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  white-space: nowrap;
}
.dsh-voice-chip-warn {
  color: #d9534f;
}
.dsh-voice-progress {
  width: 100%;
  height: 4px;
  margin: 2px 0 0;
  accent-color: var(--dsh-accent-color, #4d6bfe);
  cursor: pointer;
}
.dsh-voice-progress:disabled {
  cursor: default;
  opacity: 0.45;
}
.dsh-voice-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dsh-voice-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 30px;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  transition: background-color 120ms ease, transform 80ms ease;
}
.dsh-voice-icon:hover:not(:disabled) {
  background: color-mix(in srgb, currentColor 10%, transparent);
}
.dsh-voice-icon:active:not(:disabled) {
  transform: scale(0.96);
}
.dsh-voice-icon:disabled {
  opacity: 0.38;
  cursor: default;
}
.dsh-voice-primary {
  min-width: 38px;
  background: color-mix(in srgb, currentColor 10%, transparent);
}
.dsh-voice-spacer {
  flex: 1;
}
.dsh-voice-toggle {
  padding: 4px 9px;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  white-space: nowrap;
}
.dsh-voice-toggle[data-on='true'] {
  color: var(--dsh-accent-color, #4d6bfe);
  border-color: color-mix(in srgb, currentColor 40%, transparent);
}
.dsh-voice-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dsh-voice-label {
  font-size: 11.5px;
  opacity: 0.7;
  white-space: nowrap;
}
.dsh-voice-ratetrigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 68px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  white-space: nowrap;
}
.dsh-voice-ratetrigger:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
}
.dsh-voice-ratetrigger[aria-expanded='true'] {
  color: var(--dsh-accent-color, #4d6bfe);
  border-color: color-mix(in srgb, var(--dsh-accent-color, #4d6bfe) 55%, transparent);
}
.dsh-voice-caret {
  font-size: 9px;
  opacity: 0.7;
  transition: transform 120ms ease;
}
.dsh-voice-caret[data-open='true'] {
  transform: rotate(180deg);
}
.dsh-voice-ratemenu {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-self: flex-start;
  min-width: 76px;
  padding: 4px;
  margin-top: -2px;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, Canvas 96%, transparent);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.14);
}
.dsh-voice-rateoption {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 5px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: left;
  cursor: pointer;
}
.dsh-voice-rateoption:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
}
.dsh-voice-rateoption[data-on='true'] {
  color: var(--dsh-accent-color, #4d6bfe);
  background: color-mix(in srgb, var(--dsh-accent-color, #4d6bfe) 12%, transparent);
  font-weight: 600;
}
.dsh-voice-select {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, Canvas 88%, transparent);
  color: inherit;
  font: inherit;
  font-size: 12px;
}

@media (prefers-reduced-motion: reduce) {
  [data-dsh-voice-action],
  .dsh-voice-icon {
    transition: none;
  }
}
`

/**
 * Paint the stylesheet once per page.
 *
 * @returns the disposer that removes the `<style>` element.
 */
export function installStyles() {
  const existing = globalThis.document?.querySelector?.('style[data-dsh-voice-styles]')
  if (existing !== null && existing !== undefined) return () => {}
  const style = globalThis.document.createElement('style')
  style.setAttribute('data-dsh-voice-styles', '1')
  style.textContent = CSS
  globalThis.document.head.appendChild(style)
  return () => { style.remove() }
}
