// Unit tests for lib/chat-history.js — the caps, the config fallback and
// the message id shape.

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModelMessages, makeId, normalizeConfig } from '../lib/chat-history.js';

function stored(text, role = 'user') {
  return {
    id: makeId(),
    role,
    parts: [{ type: 'text', text }],
    status: role === 'user' ? 'complete' : 'complete',
    at: 0,
  };
}

test('should_fall_back_to_defaults_when_config_values_are_unusable', () => {
  const config = normalizeConfig({ systemInstruction: 42, maxTurns: 0, maxChars: -5 });

  assert.deepEqual(config, { systemInstruction: '', maxTurns: 10, maxChars: 20000 });
});

test('should_trim_oldest_whole_turns_when_the_turn_cap_is_exceeded', () => {
  const config = normalizeConfig({ maxTurns: 2 });
  const messages = [];
  for (const text of ['یک', 'دو', 'سه']) {
    messages.push(stored(text));
    messages.push(stored(`پاسخ ${text}`, 'assistant'));
  }

  const wire = buildModelMessages(config, messages);
  const texts = wire.filter((message) => message.role !== 'system').map((message) => message.content[0].text);

  assert.deepEqual(texts, ['دو', 'پاسخ دو', 'سه', 'پاسخ سه'], 'only the newest two turns survive');
});

test('should_count_the_system_instruction_inside_the_character_budget_when_trimming', () => {
  const config = normalizeConfig({ systemInstruction: '123456', maxChars: 20 });
  const messages = [stored('پیام اول نسبتاً بلند'), stored('پاسخ', 'assistant'), stored('پیام دوم کوتاه')];

  const wire = buildModelMessages(config, messages);
  const body = wire.filter((message) => message.role !== 'system').map((message) => message.content[0].text);

  assert.deepEqual(body, ['پیام دوم کوتاه'], 'system chars count against the budget: the old turn must go');
});

test('should_never_drop_the_current_message_when_it_alone_exceeds_the_budget', () => {
  const config = normalizeConfig({ systemInstruction: 'دستورالعمل طولانی سیستم', maxChars: 5 });

  const wire = buildModelMessages(config, [stored('پیام جاری بلندتر از سقف')]);

  assert.equal(wire.length, 2);
  assert.equal(wire[1].content[0].text, 'پیام جاری بلندتر از سقف');
});

test('should_count_context_as_part_of_its_message_when_measuring_the_budget', () => {
  const config = normalizeConfig({ maxChars: 12 });
  const withContext = {
    id: makeId(),
    role: 'user',
    parts: [{ type: 'text', text: 'پیام', context: 'زمینه‌ی نسبتاً بلند' }],
    status: 'complete',
    at: 0,
  };
  const messages = [withContext, stored('پاسخ', 'assistant'), stored('تازه')];

  const wire = buildModelMessages(config, messages);
  const texts = wire.filter((message) => message.role !== 'system').map((message) => message.content[0].text);

  assert.deepEqual(texts, ['تازه'], 'the context inflates the old message past the budget');
});

test('should_mint_distinct_ids_when_called_repeatedly', () => {
  assert.notEqual(makeId(), makeId());
  assert.match(makeId(), /^msg-/);
});
