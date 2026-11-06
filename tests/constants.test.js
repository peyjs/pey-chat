// Unit tests for lib/constants.js — names, event naming and error codes.

import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MAX_CHARS, DEFAULT_MAX_TURNS, ERROR_CODES, HISTORY_CLEARED_EVENT, MESSAGE_COMPLETED_EVENT, PLUGIN_NAME, SERVICE_NAME } from '../lib/constants.js';

test('should_expose_the_plugin_and_service_names_when_read', () => {
  assert.equal(PLUGIN_NAME, 'pey.chat');
  assert.equal(SERVICE_NAME, 'pey.chat.service');
});

test('should_name_the_chat_events_in_past_tense_when_declared', () => {
  // bonyan/naming.md: domain events read as what happened.
  assert.equal(MESSAGE_COMPLETED_EVENT, 'chat:message-completed');
  assert.equal(HISTORY_CLEARED_EVENT, 'chat:history-cleared');
});

test('should_keep_every_chat_error_code_prefixed_when_listed', () => {
  for (const code of Object.values(ERROR_CODES)) {
    assert.match(code, /^CHAT_[A-Z_]+$/, code);
  }
});

test('should_carry_conservative_cap_defaults_when_nothing_is_configured', () => {
  assert.equal(DEFAULT_MAX_TURNS, 10);
  assert.equal(DEFAULT_MAX_CHARS, 20000);
});
