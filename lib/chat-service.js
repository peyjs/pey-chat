// Provides the pey.chat service: one conversation, in memory.
//
// The plugin owns conversation logic only — history, the system
// instruction, per-message context, the sending-history cap, stop and
// retry. It never sees the key or the connection settings (pey.llm owns
// those) and never touches the network itself. Message text and context
// stay inside this module and the caller's handlers; events carry ids
// only.
//
// Boundary hygiene: structured errors (a `code` and a `source`) from
// pey.llm pass through unchanged — that is the documented pass-through
// contract — while anything raw is wrapped in a stable chat error, so no
// raw object ever crosses the plugin boundary.

import {
  ERROR_CODES,
  HISTORY_CLEARED_EVENT,
  MESSAGE_COMPLETED_EVENT,
  SERVICE_UNAVAILABLE,
} from './constants.js';
import { createChatError, normalizeLlmError } from './error.js';
import { buildModelMessages, makeId, normalizeConfig } from './chat-history.js';

/**
 * Publishes an event when the bus exists. Bus failures never fail a call —
 * the plugin carries no logger, so a broken bus cannot be surfaced except
 * by failing the user's call, which the requirements forbid (graceful
 * degradation is the contract).
 * @param {object} state Service state ({ events }).
 * @param {string} type Event type.
 * @param {object} [data] Event data.
 * @returns {void}
 */
function publish(state, type, data) {
  try {
    if (data === undefined) {
      state.events?.publish(type);
    } else {
      state.events?.publish(type, data);
    }
  } catch {
    // Event bus issues never fail a service call (see above).
  }
}

/**
 * Creates the chat service closing over activation-bound references.
 * @param {object} state References ({ llm, events, config }).
 * @returns {{service: object, deactivate: Function}} Service and lifecycle control.
 */
export function createChatService(state) {
  const config = normalizeConfig(state.config ?? {});
  let messages = [];
  let responding = false;
  let activeHandle = null;
  let stopRequested = false;
  let deactivated = false;
  // Generations guard history registration: clearing the conversation (or
  // deactivating the service) invalidates every in-flight generation, so a
  // late answer can never register into a conversation that no longer
  // exists — not even inside the narrow microtask window after cancel().
  let generation = 0;

  /**
   * Fails with the standard unavailable error when the service cannot run.
   * @returns {object} The bound pey.llm service.
   * @throws {object} SERVICE_UNAVAILABLE.
   */
  function ensureLlmAvailable() {
    if (deactivated || !state.llm) {
      throw createChatError(SERVICE_UNAVAILABLE, 'Chat service is unavailable');
    }
    return state.llm;
  }

  /**
   * Finds the index of the last user message.
   * @returns {number} Index, or -1 when none exists.
   */
  function lastUserIndex() {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') {
        return index;
      }
    }
    return -1;
  }

  /**
   * Cancels one transport without ever letting a broken pey.llm `cancel`
   * cross the boundary — worst case the transfer keeps running, but no raw
   * error reaches the caller, `teardown` or the shutdown cycle.
   * @param {object} transport Transport handle.
   * @returns {void}
   */
  function safeCancel(transport) {
    try {
      transport.cancel();
    } catch {
      // A broken pey.llm cancel is swallowed by design; the transfer may
      // keep running but nothing raw crosses the boundary.
    }
  }

  /**
   * Runs one answer generation for the conversation as it stands: streams
   * the answer through handlers, registers it in history, and resolves the
   * flow-pattern result. In retry use, the previous answer stays until the
   * first new text replaces it.
   * @param {object} handlers { onText(delta) }.
   * @returns {Promise<{cancel: Function, done: Promise<object>}>} Response handle.
   * @throws {object} Structured pey.llm errors pass through unchanged; raw ones are wrapped.
   */
  function generateAnswer(handlers) {
    const llm = ensureLlmAvailable();
    const onText = typeof handlers?.onText === 'function' ? handlers.onText : null;
    stopRequested = false;
    const ownGeneration = generation;

    const assistant = {
      id: makeId(),
      role: 'assistant',
      parts: [{ type: 'text', text: '' }],
      status: 'incomplete',
      at: Date.now(),
    };
    let registered = false;

    let transportPromise;
    try {
      transportPromise = Promise.resolve(llm.stream(
        buildModelMessages(config, messages),
        undefined,
        {
          onText: (delta) => {
            if (ownGeneration !== generation) {
              // The conversation was cleared mid-generation: deliver to the
              // caller's handler, but never register into the new history.
              onText?.(delta);
              return;
            }
            // Retry semantics: the previous answer survives until the first
            // new text arrives; then the new answer takes its place.
            if (!registered) {
              const previousIndex = messages.length - 1;
              if (previousIndex >= 0 && messages[previousIndex].role === 'assistant') {
                messages[previousIndex] = assistant;
              } else {
                messages.push(assistant);
              }
              registered = true;
            }
            assistant.parts[0].text += delta;
            onText?.(delta);
          },
        },
      ));
    } catch (error) {
      // A synchronous throw from pey.llm is still a boundary crossing.
      responding = false;
      return Promise.reject(normalizeLlmError(error));
    }

    const handlePromise = transportPromise.then((transport) => {
      // A clear()/deactivate() that arrived before the transport resolved
      // must not be lost: both bump the generation, so a late transport is
      // cancelled right away and never attached to the service state.
      // (stop() does NOT bump the generation — the pre-transport stop window
      // is closed by the separate stopRequested check below, which stays
      // load-bearing.)
      if (ownGeneration !== generation) {
        safeCancel(transport);
        // The cancelled transport's done is abandoned on this path: its
        // rejection (a pey.llm contract break, or a connection dying under
        // the abort) must never surface as an unhandled rejection that
        // crashes the host process.
        if (transport?.done && typeof transport.done.catch === 'function') {
          transport.done.catch(() => {});
        }
        // The normal path frees the lock in its done-IIFE finally; this
        // short-circuit skips that body, so the lock is freed here.
        responding = false;
        return {
          cancel: () => safeCancel(transport),
          done: Promise.resolve({ ending: 'cancelled' }),
        };
      }
      activeHandle = transport;
      // A stop() that arrived before the transport existed must not be lost.
      if (stopRequested) {
        safeCancel(transport);
      }
      return {
        cancel: () => safeCancel(transport),
        done: (async () => {
          try {
            let final;
            try {
              final = await transport.done;
            } catch (error) {
              // The contract says done NEVER rejects: a broken pey.llm
              // promise lands as a structured interruption.
              return { ending: 'interrupted', error: normalizeLlmError(error) };
            }
            if (final.ending === 'completed') {
              if (ownGeneration !== generation) {
                // The conversation was cleared mid-generation: nothing was
                // registered, so no completion may be announced for a
                // message id that exists in no history.
                return { ending: 'cancelled' };
              }
              // The stream may complete without a single delta. The retry
              // contract keeps the previous answer until NEW text arrives —
              // an empty completion is no new text, so a retry keeps the
              // previous answer and announces nothing (like the failure
              // branch); a fresh turn (the history ends with the user
              // message) still registers the (empty) answer so the turn
              // stays consistent.
              if (!registered) {
                const previousIndex = messages.length - 1;
                if (previousIndex >= 0 && messages[previousIndex].role === 'assistant') {
                  return { ending: 'completed' };
                }
                messages.push(assistant);
              }
              assistant.status = 'complete';
              publish(state, MESSAGE_COMPLETED_EVENT, { messageId: assistant.id });
              return { ending: 'completed' };
            }
            if (final.ending === 'interrupted') {
              // A mid-way failure keeps the received partial as incomplete;
              // a failure before any text keeps the previous answer.
              return { ending: 'interrupted', error: normalizeLlmError(final.error) };
            }
            return { ending: 'cancelled' };
          } finally {
            activeHandle = null;
            // Every ending — ordinary, error or cancel — frees the lock so
            // consecutive failures never wedge the conversation.
            responding = false;
          }
        })(),
      };
    }, (error) => {
      responding = false;
      throw normalizeLlmError(error);
    });

    return handlePromise;
  }

  return {
    service: {
      /**
       * Appends a user message and starts generating the answer.
       *
       * @param {object} input { text, context? }.
       * @param {object} [handlers] { onText(delta) }.
       * @returns {Promise<{cancel: Function, done: Promise<object>}>} Response handle.
       * @throws {object} SERVICE_UNAVAILABLE / CHAT_RESPONSE_IN_PROGRESS / CHAT_EMPTY_MESSAGE / structured llm errors.
       */
      async send(input, handlers) {
        ensureLlmAvailable();
        if (responding) {
          throw createChatError(ERROR_CODES.RESPONSE_IN_PROGRESS, 'Another answer is being generated; stop it first');
        }
        const text = typeof input?.text === 'string' ? input.text : '';
        if (text.trim().length === 0) {
          throw createChatError(ERROR_CODES.EMPTY_MESSAGE, 'A message needs non-empty text');
        }
        const context = typeof input.context === 'string' && input.context.length > 0 ? input.context : undefined;
        messages.push({
          id: makeId(),
          role: 'user',
          parts: [{ type: 'text', text, ...(context ? { context } : {}) }],
          status: 'complete',
          at: Date.now(),
        });
        responding = true;
        return generateAnswer(handlers);
      },

      /**
       * Cancels the answer currently being generated; the partial text
       * received so far stays in history as incomplete.
       *
       * @returns {{ok: boolean}} Confirmation.
       * @throws {object} SERVICE_UNAVAILABLE after deactivation.
       */
      stop() {
        if (deactivated) {
          throw createChatError(SERVICE_UNAVAILABLE, 'Chat service is unavailable');
        }
        stopRequested = true;
        safeCancel(activeHandle);
        return { ok: true };
      },

      /**
       * Regenerates the answer for the last user message.
       *
       * @param {object} [handlers] { onText(delta) }.
       * @returns {Promise<{cancel: Function, done: Promise<object>}>} Response handle.
       * @throws {object} SERVICE_UNAVAILABLE / CHAT_RESPONSE_IN_PROGRESS / CHAT_NO_RETRY_TARGET / structured llm errors.
       */
      async retry(handlers) {
        ensureLlmAvailable();
        if (responding) {
          throw createChatError(ERROR_CODES.RESPONSE_IN_PROGRESS, 'Another answer is being generated; stop it first');
        }
        if (lastUserIndex() === -1) {
          throw createChatError(ERROR_CODES.NO_RETRY_TARGET, 'There is no user message to retry');
        }
        responding = true;
        return generateAnswer(handlers);
      },

      /**
       * Empties the conversation.
       *
       * @returns {{ok: boolean}} Confirmation.
       * @throws {object} SERVICE_UNAVAILABLE after deactivation.
       */
      clear() {
        if (deactivated) {
          throw createChatError(SERVICE_UNAVAILABLE, 'Chat service is unavailable');
        }
        // Clearing also cuts the in-flight answer and invalidates its
        // generation, so no late delta can register into the new history.
        stopRequested = true;
        safeCancel(activeHandle);
        generation += 1;
        messages = [];
        publish(state, HISTORY_CLEARED_EVENT);
        return { ok: true };
      },

      /**
       * Returns a read-only copy of the conversation.
       *
       * @returns {Array} Messages.
       * @throws {object} SERVICE_UNAVAILABLE after deactivation.
       */
      getHistory() {
        if (deactivated) {
          throw createChatError(SERVICE_UNAVAILABLE, 'Chat service is unavailable');
        }
        return messages.map((message) => ({
          id: message.id,
          role: message.role,
          parts: message.parts.map((part) => ({ ...part })),
          status: message.status,
          at: message.at,
        }));
      },
    },

    deactivate() {
      deactivated = true;
      // Cutting the in-flight answer and invalidating its generation keeps
      // deactivation from leaving a silent hang or a late registration; the
      // partial text stays as incomplete. A broken pey.llm cancel must
      // never reach teardown or the Core shutdown cycle.
      safeCancel(activeHandle);
      generation += 1;
      activeHandle = null;
      responding = false;
    },
  };
}
