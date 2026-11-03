// Creates safe Bonyan errors at the pey.chat plugin boundary. Messages
// are fixed: message text and context never appear in an error.

import { ERROR_CODES, PLUGIN_NAME } from './constants.js';

const ERROR_TYPES = new Set(['startup', 'operational', 'critical']);
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Creates a standard Bonyan error owned by this plugin.
 *
 * @param {string} code Stable machine-readable error code.
 * @param {string} message Safe human-readable message.
 * @param {'startup'|'operational'|'critical'} [type='operational'] Error category.
 * @returns {{code: string, message: string, source: string, type: string, timestamp: string}}
 * @throws {TypeError} When the error type is unsupported.
 */
export function createChatError(code, message, type = 'operational') {
  if (!ERROR_CODE_PATTERN.test(code)) {
    throw new TypeError(`Unsupported error code: ${code}`);
  }
  if (!ERROR_TYPES.has(type)) {
    throw new TypeError(`Unsupported Bonyan error type: ${type}`);
  }

  return {
    code,
    message,
    source: PLUGIN_NAME,
    type,
    timestamp: new Date().toISOString(),
  };
}
