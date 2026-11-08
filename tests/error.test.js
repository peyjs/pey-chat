// Unit tests for lib/error.js — the pey.chat boundary error factory.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatError } from '../lib/error.js';
import { ERROR_CODES } from '../lib/constants.js';

test('should_build_standard_structured_error_when_called_with_code_and_message', () => {
  const error = createChatError(ERROR_CODES.EMPTY_MESSAGE, 'A message needs non-empty text');

  assert.equal(error.code, 'CHAT_EMPTY_MESSAGE');
  assert.equal(error.source, 'pey.chat');
  assert.equal(error.type, 'operational');
  assert.ok(!Number.isNaN(Date.parse(error.timestamp)));
});

test('should_reject_unsupported_codes_and_types_when_misused', () => {
  assert.throws(() => createChatError('lowercase-code', 'x'), TypeError);
  assert.throws(() => createChatError('CHAT_EMPTY_MESSAGE', 'x', 'fatal'), TypeError);
});

