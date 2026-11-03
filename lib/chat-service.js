// Provides the pey.chat service: one conversation, in memory.
//
// The plugin owns conversation logic only — history, the system
// instruction, per-message context, the sending-history cap, stop and
// retry. It never sees the key or the connection settings (pey.llm owns
// those) and never touches the network itself. Message text and context
// stay inside this module and the caller's handlers; events carry ids
// only.

import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_TURNS,
  DEFAULT_SYSTEM_INSTRUCTION,
  ERROR_CODES,
  HISTORY_CLEARED_EVENT,
  LLM_SERVICE,
  MESSAGE_COMPLETED_EVENT,
  SERVICE_UNAVAILABLE,
} from './constants.js';
import { createChatError } from './error.js';

/**
 * Publishes an event when the bus exists. Bus failures never fail a call.
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
    // Event bus issues never fail a service call.
  }
}

/**
 * Validates and normalizes the plugin configuration.
 * @param {object} config Merged plugin configuration.
 * @returns {object} Normalized config.
 */
function normalizeConfig(config) {
  const systemInstruction = typeof config.systemInstruction === 'string' ? config.systemInstruction : DEFAULT_SYSTEM_INSTRUCTION;
  const maxTurns = Number.isFinite(config.maxTurns) && config.maxTurns >= 1 ? Math.floor(config.maxTurns) : DEFAULT_MAX_TURNS;
  const maxChars = Number.isFinite(config.maxChars) && config.maxChars >= 1 ? Math.floor(config.maxChars) : DEFAULT_MAX_CHARS;
  return { systemInstruction, maxTurns, maxChars };
}

/**
 * Builds a unique-enough message id.
 * @returns {string} Id.
 */
function makeId() {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Counts the characters one message contributes to the sending budget:
 * every text part plus the context that travels with it.
 * @param {object} message Stored message.
 * @returns {number} Character count.
 */
function messageChars(message) {
  return message.parts.reduce((sum, part) => sum + (part.text?.length ?? 0) + (part.context?.length ?? 0), 0);
}

/**
 * Merges a message's context into the text sent to the model: the context
 * travels with its message and counts toward its size.
 * @param {object} part Text part.
 * @returns {string} Model-facing text.
 */
function partTextForModel(part) {
  return part.context ? `${part.context}\n\n${part.text}` : part.text;
}

/**
 * Builds the conversation messages for one model call under the
 * sending-history cap: the system instruction always goes (never
 * dropped, but counted), the current message always goes, and older
 * complete turns are dropped oldest-first when either cap is exceeded.
 * The displayed history is untouched.
 * @param {object} config Normalized config.
 * @param {Array} messages Stored conversation.
 * @returns {Array} Wire messages for pey.llm.
 */
function buildModelMessages(config, messages) {
  // A turn is one user message plus the assistant answer(s) that follow it.
  const turns = [];
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push([message]);
    } else if (turns.length > 0) {
      turns[turns.length - 1].push(message);
    }
  }

  const system = config.systemInstruction.length > 0
    ? [{ role: 'system', content: [{ type: 'text', text: config.systemInstruction }] }]
    : [];
  const systemChars = config.systemInstruction.length;

  const budget = systemChars + config.maxChars;
  let kept = [...turns];
  let keptChars = systemChars + kept.reduce((sum, turn) => sum + turn.reduce((inner, message) => inner + messageChars(message), 0), 0);
  // The current message is the last user message: never dropped. When the
  // system instruction and the current message alone exceed the cap,
  // nothing is dropped and the request goes anyway — pey.llm then reports
  // the provider's length refusal.
  while (kept.length > 1 && (kept.length > config.maxTurns || keptChars > budget)) {
    const dropped = kept[0];
    keptChars -= dropped.reduce((sum, message) => sum + messageChars(message), 0);
    kept = kept.slice(1);
  }

  const wire = [...system];
  for (const turn of kept) {
    for (const message of turn) {
      wire.push({
        role: message.role,
        content: message.parts.map((part) => ({ type: 'text', text: partTextForModel(part) })),
      });
    }
  }
  return wire;
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

  function requireLlm() {
    if (!state.llm) {
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
   * Runs one answer generation for the conversation as it stands: streams
   * the answer through handlers, registers it in history, and resolves the
   * flow-pattern result. In retry use, the previous answer stays until the
   * first new text replaces it.
   * @param {object} handlers { onText(delta) }.
   * @returns {Promise<{cancel: Function, done: Promise<object>}>} Response handle.
   * @throws {object} pey.llm validation errors pass through unchanged.
   */
  function generateAnswer(handlers) {
    const llm = requireLlm();
    const onText = typeof handlers?.onText === 'function' ? handlers.onText : null;
    stopRequested = false;

    const assistant = {
      id: makeId(),
      role: 'assistant',
      parts: [{ type: 'text', text: '' }],
      status: 'incomplete',
      at: Date.now(),
    };
    let registered = false;

    const transportPromise = llm.stream(
      buildModelMessages(config, messages),
      undefined,
      {
        onText: (delta) => {
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
    );

    const handlePromise = transportPromise.then((transport) => {
      activeHandle = transport;
      // A stop() that arrived before the transport existed must not be lost.
      if (stopRequested) {
        transport.cancel();
      }
      return {
        cancel: () => transport.cancel(),
        done: (async () => {
          try {
            const final = await transport.done;
            if (final.ending === 'completed') {
              // Retry with no new text at all: the stream may complete
              // without a single delta; still register the (empty) answer
              // so the turn stays consistent.
              if (!registered) {
                messages.push(assistant);
                registered = true;
              }
              assistant.status = 'complete';
              publish(state, MESSAGE_COMPLETED_EVENT, { messageId: assistant.id });
              return { ending: 'completed' };
            }
            if (final.ending === 'interrupted') {
              // A mid-way failure keeps the received partial as incomplete;
              // a failure before any text keeps the previous answer.
              return { ending: 'interrupted', error: final.error };
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
      // pey.llm validation errors (and unavailability) surface as-is.
      responding = false;
      throw error;
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
       * @throws {object} CHAT_EMPTY_MESSAGE / CHAT_RESPONSE_IN_PROGRESS / pass-through llm errors.
       */
      async send(input, handlers) {
        const llm = requireLlm();
        void llm;
        const text = typeof input?.text === 'string' ? input.text : '';
        if (text.trim().length === 0) {
          throw createChatError(ERROR_CODES.EMPTY_MESSAGE, 'A message needs non-empty text');
        }
        if (responding) {
          throw createChatError(ERROR_CODES.RESPONSE_IN_PROGRESS, 'Another answer is being generated; stop it first');
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
       */
      stop() {
        stopRequested = true;
        activeHandle?.cancel();
        return { ok: true };
      },

      /**
       * Regenerates the answer for the last user message.
       *
       * @param {object} [handlers] { onText(delta) }.
       * @returns {Promise<{cancel: Function, done: Promise<object>}>} Response handle.
       * @throws {object} CHAT_NO_RETRY_TARGET / CHAT_RESPONSE_IN_PROGRESS / pass-through llm errors.
       */
      async retry(handlers) {
        const llm = requireLlm();
        void llm;
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
       */
      clear() {
        // Clearing also cuts an in-flight answer, so no generation can
        // register into a conversation that no longer exists.
        stopRequested = true;
        activeHandle?.cancel();
        messages = [];
        publish(state, HISTORY_CLEARED_EVENT);
        return { ok: true };
      },

      /**
       * Returns a read-only copy of the conversation.
       *
       * @returns {Array} Messages.
       */
      getHistory() {
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
      // Cutting the in-flight answer keeps deactivation from leaving a
      // silent hang; the partial text stays as incomplete.
      activeHandle?.cancel();
      activeHandle = null;
      responding = false;
    },
  };
}
