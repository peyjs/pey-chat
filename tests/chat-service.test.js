// Verifies the pey.chat service against the acceptance criteria of
// docs/requirements.md — with a fake pey.llm, never a real network.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatService } from '../lib/chat-service.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a fake stream handle: feeds text deltas through handlers.onText
 * and resolves with the configured ending.
 */
function makeHandle(handlers, deltas, { delayMs = 0, ending = 'completed', error } = {}) {
  let cancelled = false;
  return {
    cancel() {
      cancelled = true;
    },
    done: (async () => {
      for (const delta of deltas) {
        await sleep(delayMs);
        if (cancelled) {
          return { ending: 'cancelled' };
        }
        handlers.onText(delta);
      }
      if (cancelled) {
        return { ending: 'cancelled' };
      }
      if (ending === 'interrupted') {
        return { ending: 'interrupted', error };
      }
      return { ending: 'completed' };
    })(),
  };
}

function createFakeLlm(map = {}) {
  const calls = [];
  const llm = {
    calls,
    async stream(messages, options, handlers) {
      calls.push({ messages, handlers });
      if (map.stream) {
        return map.stream(messages, handlers);
      }
      return makeHandle(handlers, ['پاسخ']);
    },
  };
  return llm;
}

function createService({ config, map } = {}) {
  const published = [];
  const llm = createFakeLlm(map);
  const { service, deactivate } = createChatService({
    llm,
    events: { publish: (type, data) => published.push({ type, data }) },
    config: config ?? {},
  });
  return { service, deactivate, llm, published };
}

function wireTexts(call) {
  return call.messages.map((message) => ({
    role: message.role,
    text: message.content.map((part) => part.text).join('\n'),
  }));
}

// --- the happy path ------------------------------------------------------

test('should_send_history_with_system_instruction_and_register_the_answer', async () => {
  const received = [];
  const { service, llm, published } = createService({ config: { systemInstruction: 'دستورالعمل سیستم' } });

  const first = await service.send({ text: 'اول' }, { onText: (t) => received.push(t) });
  await first.done;
  const second = await service.send({ text: 'دوم' }, { onText: (t) => received.push(t) });
  const final = await second.done;

  assert.deepEqual(received, ['پاسخ', 'پاسخ']);
  assert.equal(final.ending, 'completed');
  const lastCall = wireTexts(llm.calls[1]);
  assert.deepEqual(lastCall, [
    { role: 'system', text: 'دستورالعمل سیستم' },
    { role: 'user', text: 'اول' },
    { role: 'assistant', text: 'پاسخ' },
    { role: 'user', text: 'دوم' },
  ]);
  const history = service.getHistory();
  assert.equal(history.length, 4);
  assert.equal(history[3].role, 'assistant');
  assert.equal(history[3].status, 'complete');
  assert.deepEqual(published.filter((event) => event.type === 'chat:message-completed').map((event) => event.data.messageId), [history[1].id, history[3].id]);
});

test('should_keep_context_with_its_message_and_send_it_to_the_model', async () => {
  const { service, llm } = createService();

  const first = await service.send({ text: 'این درباره چیست؟', context: 'متن انتخاب‌شده' }, { onText: () => {} });
  await first.done;
  const second = await service.send({ text: 'بیشتر توضیح بده' }, { onText: () => {} });
  await second.done;

  const firstCall = wireTexts(llm.calls[0]);
  assert.equal(firstCall[0].text.includes('متن انتخاب‌شده'), true);
  assert.equal(firstCall[0].text.includes('این درباره چیست؟'), true);
  // The context of the first message travels with it in later turns too.
  const secondCall = wireTexts(llm.calls[1]);
  assert.equal(secondCall[0].text.includes('متن انتخاب‌شده'), true);
  const history = service.getHistory();
  assert.equal(history[0].parts[0].context, 'متن انتخاب‌شده');
});

// --- stop, mid-way failure, retry -----------------------------------------

test('should_keep_the_partial_answer_incomplete_when_stopped', async () => {
  const { service } = createService({
    map: { stream: (messages, handlers) => makeHandle(handlers, ['بخش اول', 'بخش دوم'], { delayMs: 15 }) },
  });

  const handle = await service.send({ text: 'سلام' }, { onText: () => {} });
  await sleep(25);
  service.stop();
  const final = await handle.done;

  assert.equal(final.ending, 'cancelled');
  const history = service.getHistory();
  assert.equal(history[1].status, 'incomplete');
  assert.equal(history[1].parts[0].text, 'بخش اول');
});

test('should_keep_the_partial_answer_and_pass_the_error_when_it_fails_midway', async () => {
  const llmError = { code: 'LLM_RATE_LIMITED', message: 'limit', source: 'pey.llm', type: 'operational', timestamp: 't' };
  const { service } = createService({
    map: { stream: (messages, handlers) => makeHandle(handlers, ['نیمه'], { ending: 'interrupted', error: llmError }) },
  });

  const handle = await service.send({ text: 'سلام' }, { onText: () => {} });
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'LLM_RATE_LIMITED');
  const history = service.getHistory();
  assert.equal(history[1].status, 'incomplete');
  assert.equal(history[1].parts[0].text, 'نیمه');
});

test('should_replace_the_previous_answer_only_when_the_first_new_text_arrives', async () => {
  let attempt = 0;
  const { service } = createService({
    map: {
      stream: (messages, handlers) => {
        attempt += 1;
        if (attempt === 1) {
          return makeHandle(handlers, ['پاسخ اولیه']);
        }
        return makeHandle(handlers, ['جایگزین'], { delayMs: 10 });
      },
    },
  });

  const first = await service.send({ text: 'سؤال' }, { onText: () => {} });
  await first.done;
  assert.equal(service.getHistory()[1].parts[0].text, 'پاسخ اولیه');

  const second = await service.retry({ onText: () => {} });
  await second.done;

  const history = service.getHistory();
  assert.equal(history.length, 2);
  assert.equal(history[1].parts[0].text, 'جایگزین');
  assert.equal(history[1].status, 'complete');
});

test('should_keep_the_previous_answer_when_the_retry_fails_before_any_text', async () => {
  let attempt = 0;
  const { service } = createService({
    map: {
      stream: (messages, handlers) => {
        attempt += 1;
        if (attempt === 1) {
          return makeHandle(handlers, ['پاسخ سالم']);
        }
        return makeHandle(handlers, [], {
          ending: 'interrupted',
          error: { code: 'HTTP_NETWORK_FAILED', message: 'down', source: 'pey.http', type: 'operational', timestamp: 't' },
        });
      },
    },
  });

  const first = await service.send({ text: 'سؤال' }, { onText: () => {} });
  await first.done;

  const second = await service.retry({ onText: () => {} });
  const final = await second.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'HTTP_NETWORK_FAILED');
  const history = service.getHistory();
  assert.equal(history.length, 2);
  assert.equal(history[1].parts[0].text, 'پاسخ سالم');
  assert.equal(history[1].status, 'complete');
});

test('should_replace_with_the_partial_when_the_retry_fails_midway', async () => {
  let attempt = 0;
  const { service } = createService({
    map: {
      stream: (messages, handlers) => {
        attempt += 1;
        if (attempt === 1) {
          return makeHandle(handlers, ['پاسخ قبلی']);
        }
        return makeHandle(handlers, ['نیمه‌ی نو'], {
          ending: 'interrupted',
          error: { code: 'LLM_STREAM_INTERRUPTED', message: 'cut', source: 'pey.llm', type: 'operational', timestamp: 't' },
        });
      },
    },
  });

  const first = await service.send({ text: 'سؤال' }, { onText: () => {} });
  await first.done;

  const second = await service.retry({ onText: () => {} });
  await second.done;

  const history = service.getHistory();
  assert.equal(history.length, 2);
  assert.equal(history[1].parts[0].text, 'نیمه‌ی نو');
  assert.equal(history[1].status, 'incomplete');
});

test('should_retry_after_a_failed_attempt_with_no_answer_at_all', async () => {
  let attempt = 0;
  const { service, llm } = createService({
    map: {
      stream: (messages, handlers) => {
        attempt += 1;
        if (attempt === 1) {
          return makeHandle(handlers, [], {
            ending: 'interrupted',
            error: { code: 'LLM_REQUEST_FAILED', message: 'x', source: 'pey.llm', type: 'operational', timestamp: 't' },
          });
        }
        return makeHandle(handlers, ['حالا رسید']);
      },
    },
  });

  const first = await service.send({ text: 'سؤال' }, { onText: () => {} });
  await first.done;
  assert.equal(service.getHistory().length, 1);

  const second = await service.retry({ onText: () => {} });
  await second.done;

  const history = service.getHistory();
  assert.equal(history.length, 2);
  assert.equal(history[1].parts[0].text, 'حالا رسید');
  assert.equal(llm.calls[1].messages.length, llm.calls[0].messages.length);
});

// --- the one-response-at-a-time lock --------------------------------------

test('should_reject_a_second_send_while_an_answer_is_being_generated', async () => {
  const { service } = createService({
    map: { stream: (messages, handlers) => makeHandle(handlers, ['کند'], { delayMs: 30 }) },
  });

  const first = await service.send({ text: 'اول' }, { onText: () => {} });
  await assert.rejects(
    () => service.send({ text: 'دوم' }, { onText: () => {} }),
    (error) => error.code === 'CHAT_RESPONSE_IN_PROGRESS',
  );
  await assert.rejects(
    () => service.retry({ onText: () => {} }),
    (error) => error.code === 'CHAT_RESPONSE_IN_PROGRESS',
  );
  service.stop();
  await first.done;
});

test('should_free_the_lock_after_every_ending_including_consecutive_failures', async () => {
  const { service } = createService({
    map: {
      stream: (messages, handlers) => makeHandle(handlers, [], {
        ending: 'interrupted',
        error: { code: 'LLM_REQUEST_FAILED', message: 'x', source: 'pey.llm', type: 'operational', timestamp: 't' },
      }),
    },
  });

  const first = await service.send({ text: 'اول' }, { onText: () => {} });
  await first.done;
  const second = await service.send({ text: 'دوم' }, { onText: () => {} });
  await second.done;
  const third = await service.retry({ onText: () => {} });
  const final = await third.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(service.getHistory().filter((message) => message.role === 'user').length, 2);
});

// --- validation -----------------------------------------------------------

test('should_reject_empty_messages_without_touching_history', async () => {
  const { service } = createService();

  await assert.rejects(() => service.send({ text: '' }), (error) => error.code === 'CHAT_EMPTY_MESSAGE');
  await assert.rejects(() => service.send({ text: '   ' }), (error) => error.code === 'CHAT_EMPTY_MESSAGE');
  await assert.rejects(() => service.send({}), (error) => error.code === 'CHAT_EMPTY_MESSAGE');
  assert.equal(service.getHistory().length, 0);
});

test('should_reject_retry_when_no_user_message_exists', async () => {
  const { service } = createService();

  await assert.rejects(() => service.retry({ onText: () => {} }), (error) => error.code === 'CHAT_NO_RETRY_TARGET');
});

test('should_pass_llm_error_codes_through_unchanged', async () => {
  const { service } = createService({
    map: {
      stream: () => Promise.reject({ code: 'LLM_NOT_CONFIGURED', message: 'not configured', source: 'pey.llm', type: 'operational', timestamp: 't' }),
    },
  });

  const error = await service.send({ text: 'سلام' }, { onText: () => {} }).catch((caught) => caught);
  assert.equal(error.code, 'LLM_NOT_CONFIGURED');
  assert.equal(error.source, 'pey.llm');
});

// --- the sending-history cap ----------------------------------------------

test('should_trim_oldest_whole_turns_from_the_model_payload_but_keep_history', async () => {
  const { service, llm } = createService({ config: { maxTurns: 2, maxChars: 20000 } });

  for (const text of ['یک', 'دو', 'سه']) {
    const handle = await service.send({ text }, { onText: () => {} });
    await handle.done;
  }

  const wire = wireTexts(llm.calls[2]);
  assert.equal(wire.filter((message) => message.role === 'user').length, 2);
  assert.equal(wire[0].text, 'دو');
  assert.equal(wire.at(-1).text, 'سه');
  // The displayed history keeps everything.
  assert.equal(service.getHistory().length, 6);
});

test('should_trim_by_characters_and_never_drop_the_system_instruction_or_current_message', async () => {
  const { service, llm } = createService({ config: { systemInstruction: 'دستور', maxTurns: 50, maxChars: 20 } });

  const first = await service.send({ text: 'پیام اول نسبتاً بلند' }, { onText: () => {} });
  await first.done;
  const second = await service.send({ text: 'دوم' }, { onText: () => {} });
  await second.done;

  const wire = wireTexts(llm.calls[1]);
  assert.equal(wire[0].role, 'system');
  assert.equal(wire[0].text, 'دستور');
  assert.equal(wire.some((message) => message.text === 'پیام اول نسبتاً بلند'), false);
  assert.equal(wire.at(-1).text, 'دوم');
});

test('should_send_anyway_when_the_system_instruction_and_current_message_alone_exceed_the_cap', async () => {
  const { service, llm } = createService({ config: { systemInstruction: 'دستورالعمل طولانی سیستم', maxChars: 5 } });

  const handle = await service.send({ text: 'پیام جاری بلندتر از سقف' }, { onText: () => {} });
  const final = await handle.done;

  assert.equal(final.ending, 'completed');
  const wire = wireTexts(llm.calls[0]);
  assert.equal(wire.length, 2);
  assert.equal(wire[0].role, 'system');
  assert.equal(wire[1].text, 'پیام جاری بلندتر از سقف');
});

test('should_send_the_incomplete_answer_to_the_model_on_the_next_turn', async () => {
  let attempt = 0;
  const { service, llm } = createService({
    map: {
      stream: (messages, handlers) => {
        attempt += 1;
        if (attempt === 1) {
          return makeHandle(handlers, ['نیمه'], {
            ending: 'interrupted',
            error: { code: 'LLM_STREAM_INTERRUPTED', message: 'c', source: 'pey.llm', type: 'operational', timestamp: 't' },
          });
        }
        return makeHandle(handlers, ['پاسخ دوم']);
      },
    },
  });

  const first = await service.send({ text: 'سؤال' }, { onText: () => {} });
  await first.done;
  assert.equal(service.getHistory()[1].status, 'incomplete');

  const second = await service.send({ text: 'ادامه' }, { onText: () => {} });
  await second.done;

  const wire = wireTexts(llm.calls[1]);
  assert.equal(wire.length, 3);
  assert.deepEqual(wire[1], { role: 'assistant', text: 'نیمه' });
});

// --- secrecy, clearing, history copies -------------------------------------

test('should_never_put_message_text_into_events', async () => {
  const { service, published } = createService();

  const handle = await service.send({ text: 'متن محرمانه کاربر' }, { onText: () => {} });
  await handle.done;
  service.clear();

  const dumped = JSON.stringify(published);
  assert.equal(dumped.includes('متن محرمانه کاربر'), false);
  assert.equal(dumped.includes('پاسخ'), false);
  assert.deepEqual(published.at(-1), { type: 'chat:history-cleared', data: undefined });
});

test('should_return_history_copies_that_do_not_affect_internal_state', async () => {
  const { service } = createService();

  const handle = await service.send({ text: 'سلام' }, { onText: () => {} });
  await handle.done;
  const copy = service.getHistory();
  copy[0].parts[0].text = 'دستکاری';
  copy.pop();

  const fresh = service.getHistory();
  assert.equal(fresh.length, 2);
  assert.equal(fresh[0].parts[0].text, 'سلام');
});

test('should_clear_the_conversation_and_start_fresh', async () => {
  const { service, llm } = createService();

  const first = await service.send({ text: 'سلام' }, { onText: () => {} });
  await first.done;
  service.clear();
  const second = await service.send({ text: 'دوباره' }, { onText: () => {} });
  await second.done;

  const wire = wireTexts(llm.calls[1]);
  assert.equal(wire.length, 1);
  assert.equal(wire[0].text, 'دوباره');
});
