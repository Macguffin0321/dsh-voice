/**
 * The slot registrations `dsh-voice` contributes to the chat surface.
 *
 * @module dsh-voice/client/actions
 */

import { SpeakerButton, SessionProbe } from './ui.js'

/**
 * The per-message speaker button, in the assistant action row that ui-chat
 * renders under every settled reply.
 *
 * @param ctx - browser plugin context.
 * @param voice - the shared voice facade.
 */
export function registerMessageAction(ctx, voice) {
  return ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'voice',
    order: 30,
    inject: (sessionId) => ({
      voice,
      sessionId,
    }),
  }, SpeakerButton))
}

/**
 * The invisible probe in the composer's left seat. It is mounted for exactly
 * the session the open conversation belongs to, which is how the live
 * transport knows which session's assistant text to follow — the reader then
 * hears the reply of the conversation they are actually looking at.
 *
 * @param ctx - browser plugin context.
 * @param voice - the shared voice facade.
 */
export function registerSessionProbe(ctx, voice) {
  return ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'voice-probe',
    order: 80,
    inject: (sessionId) => ({ voice, sessionId }),
  }, SessionProbe))
}
