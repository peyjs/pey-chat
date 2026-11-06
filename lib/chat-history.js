// History shaping for the pey.chat plugin: config normalization, message
// identity, and the model-facing message list under the sending caps.
// Pure logic — no I/O, no clock reads beyond id stamping.

import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_TURNS,
  DEFAULT_SYSTEM_INSTRUCTION,
} from './constants.js';

/**
 * Validates and normalizes the plugin configuration. Unusable values fall
 * back to the defaults instead of failing startup.
 * @param {object} config Merged plugin configuration.
 * @returns {object} Normalized config.
 */
export function normalizeConfig(config) {
  const systemInstruction = typeof config.systemInstruction === 'string' ? config.systemInstruction : DEFAULT_SYSTEM_INSTRUCTION;
  const maxTurns = Number.isFinite(config.maxTurns) && config.maxTurns >= 1 ? Math.floor(config.maxTurns) : DEFAULT_MAX_TURNS;
  const maxChars = Number.isFinite(config.maxChars) && config.maxChars >= 1 ? Math.floor(config.maxChars) : DEFAULT_MAX_CHARS;
  return { systemInstruction, maxTurns, maxChars };
}

/**
 * Builds a message id. `crypto.randomUUID` where it exists (Node >= 22,
 * browsers), a time-plus-random fallback elsewhere.
 * @returns {string} Id.
 */
export function makeId() {
  const random = globalThis.crypto?.randomUUID?.();
  return random !== undefined ? `msg-${random}` : `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Counts the characters one message contributes to the sending budget:
 * every text part plus the context that travels with it.
 * @param {object} message Stored message.
 * @returns {number} Character count.
 */
export function messageChars(message) {
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
 * sending-history cap: the system instruction always goes (never dropped,
 * and counted inside the character budget, because it goes to the model),
 * the current message always goes, and older complete turns are dropped
 * oldest-first when either cap is exceeded. The displayed history is
 * untouched.
 * @param {object} config Normalized config.
 * @param {Array} messages Stored conversation.
 * @returns {Array} Wire messages for pey.llm.
 */
export function buildModelMessages(config, messages) {
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

  const budget = config.maxChars;
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
