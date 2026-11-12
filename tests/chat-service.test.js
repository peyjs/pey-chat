// Verifies the pey.chat service against the acceptance criteria of
// docs/requirements.md — with a fake pey.llm, never a real network.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatService } from '../lib/chat-service.js';

/**
 * A manual gate for deterministic stream pacing: delta delivery waits on
 * `wait()` until the test calls `open()`. Replaces real timers so tests
 * never depend on wall-clock scheduling.
 */
function createGate() {
  let openGate = null;
  const promise = new Promise((resolve) => {
    openGate = resolve;
  });
  return { wait: () => promise, open: openGate };
}

/**
 * Builds a fake stream handle: feeds text deltas through handlers.onText
 * and resolves with the configured ending.
 */
function makeHandle(handlers, deltas, { gates = null, ending = 'completed', error } = {}) {
  let cancelled = false;
  return {
    cancel() {
      cancelled = true;
    },
    done: (async () => {
      for (let index = 0; index < deltas.length; index += 1) {
        if (gates !== null) {
          await gates[index].wait();
        }
        if (cancelled) {
          return { ending: 'cancelled' };
        }
        handlers.onText(deltas[index]);
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

test('should_send_history_with_the_system_instruction_when_the_answer_completes', async () => {
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

test('should_keep_context_with_its_message_when_the_payload_is_built', async () => {
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
  const gates = [createGate(), createGate()];
  let resolveFirst = null;
  const firstDelivered = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const { service } = createService({
    map: {
      stream: (messages, handlers) => makeHandle(handlers, ['بخش اول', 'بخش دوم'], {
        gates,
      }),
    },
  });

  const handle = await service.send({ text: 'سلام' }, {
    onText: () => resolveFirst?.(),
  });
  gates[0].open();
  await firstDelivered;
  service.stop();
  gates[1].open();
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

test('should_keep_the_previous_answer_when_a_retry_completes_without_any_text', async () => {
  // The retry contract keeps the previous answer until NEW text arrives;
  // a zero-delta completion is no new text — nothing is appended, nothing
  // is announced (same outcome family as the failure branch).
  let attempt = 0;
  const { service, published } = createService({
    map: {
      stream: (messages, handlers) => {
        attempt += 1;
        return attempt === 1 ? makeHandle(handlers, ['پاسخ اولیه']) : makeHandle(handlers, []);
      },
    },
  });

  const first = await service.send({ text: 'سؤال' }, { onText: () => {} });
  await first.done;
  assert.equal(service.getHistory()[1].parts[0].text, 'پاسخ اولیه');

  const second = await service.retry({ onText: () => {} });
  const final = await second.done;

  assert.equal(final.ending, 'completed');
  assert.equal(service.getHistory().length, 2, 'no empty answer is appended');
  assert.equal(service.getHistory()[1].parts[0].text, 'پاسخ اولیه', 'the previous answer survives an empty completion');
  assert.equal(published.filter((event) => event.type === 'chat:message-completed').length, 1, 'only the first completion was announced');
});

test('should_register_the_empty_answer_when_a_fresh_send_completes_without_any_text', async () => {
  // A fresh turn ends with the user message: the (empty) assistant answer
  // is still registered so the turn stays consistent, and it is announced.
  const { service, published } = createService({
    map: {
      stream: (messages, handlers) => makeHandle(handlers, []),
    },
  });

  const handle = await service.send({ text: 'سؤال' }, { onText: () => {} });
  const final = await handle.done;

  assert.equal(final.ending, 'completed');
  const history = service.getHistory();
  assert.equal(history.length, 2);
  assert.equal(history[1].role, 'assistant');
  assert.equal(history[1].parts[0].text, '');
  assert.equal(published.filter((event) => event.type === 'chat:message-completed').length, 1);
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
        return makeHandle(handlers, ['جایگزین']);
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

test('should_retry_the_last_user_message_when_the_previous_attempt_had_no_answer', async () => {
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

test('should_reject_a_second_send_when_an_answer_is_still_being_generated', async () => {
  const gates = [createGate()];
  const { service } = createService({
    map: { stream: (messages, handlers) => makeHandle(handlers, ['کند'], { gates }) },
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
  gates[0].open();
  await first.done;
});

test('should_free_the_lock_when_endings_are_consecutive_failures', async () => {
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

test('should_cancel_even_when_stop_arrives_before_the_stream_starts', async () => {
  const gates = [createGate()];
  const { service } = createService({
    map: { stream: (messages, handlers) => makeHandle(handlers, ['کند'], { gates }) },
  });

  const pending = service.send({ text: 'سلام' }, { onText: () => {} });
  service.stop();
  gates[0].open();
  const handle = await pending;
  const final = await handle.done;

  assert.equal(final.ending, 'cancelled');
  assert.equal(service.getHistory()[1]?.parts[0].text ?? '', '');
});

test('should_cut_the_in_flight_answer_when_the_conversation_is_cleared', async () => {
  const gates = [createGate()];
  const { service, published } = createService({
    map: { stream: (messages, handlers) => makeHandle(handlers, ['تکه'], { gates }) },
  });

  const pending = service.send({ text: 'سلام' }, { onText: () => {} });
  service.clear();
  gates[0].open();
  const handle = await pending;
  const final = await handle.done;

  assert.equal(final.ending, 'cancelled');
  assert.equal(service.getHistory().length, 0);
  assert.deepEqual(published.at(-1), { type: 'chat:history-cleared', data: undefined });
  // After every ending the lock is free again.
  const next = await service.send({ text: 'دوباره' }, { onText: () => {} });
  await next.done;
  assert.equal(service.getHistory().length, 2);
});

// --- validation -----------------------------------------------------------

test('should_reject_empty_messages_when_the_text_is_blank', async () => {
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

test('should_pass_llm_error_codes_through_unchanged_when_the_model_service_fails', async () => {
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

test('should_trim_oldest_whole_turns_when_the_turn_cap_is_exceeded', async () => {
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

test('should_trim_by_characters_when_the_character_budget_is_exceeded', async () => {
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

test('should_send_the_incomplete_answer_when_the_next_turn_is_sent', async () => {
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

test('should_never_put_message_text_into_events_when_a_message_completes', async () => {
  const { service, published } = createService();

  const handle = await service.send({ text: 'متن محرمانه کاربر' }, { onText: () => {} });
  await handle.done;
  service.clear();

  const dumped = JSON.stringify(published);
  assert.equal(dumped.includes('متن محرمانه کاربر'), false);
  assert.equal(dumped.includes('پاسخ'), false);
  assert.deepEqual(published.at(-1), { type: 'chat:history-cleared', data: undefined });
});

test('should_return_history_copies_when_the_history_is_read', async () => {
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

test('should_clear_the_conversation_when_clear_is_called', async () => {
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

// --- boundary hygiene -----------------------------------------------------

test('should_wrap_raw_llm_errors_when_the_model_service_rejects_with_a_raw_object', async () => {
  const { service } = createService({
    map: {
      stream: () => {
        const raw = Promise.reject(new Error('raw failure'));
        raw.catch(() => {});
        return raw;
      },
    },
  });

  await assert.rejects(
    () => service.send({ text: 'سلام' }, { onText: () => {} }),
    (error) => error.code === 'CHAT_LLM_MALFORMED_ERROR' && error.source === 'pey.chat',
  );
});

test('should_report_malformed_error_when_llm_stream_throws_synchronously', async () => {
  let attempts = 0;
  const { service } = createService({
    map: {
      stream: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('sync bug in pey.llm');
        }
        return makeHandle({ onText: () => {} }, ['پاسخ']);
      },
    },
  });

  await assert.rejects(
    () => service.send({ text: 'سلام' }, { onText: () => {} }),
    (error) => error.code === 'CHAT_LLM_MALFORMED_ERROR',
  );
  // The lock must be freed so the conversation stays usable.
  const handle = await service.send({ text: 'دوم' }, { onText: () => {} });
  await handle.done;
});

test('should_wrap_raw_error_when_a_stream_ends_interrupted_raw', async () => {
  const { service } = createService({
    map: {
      stream: (messages, handlers) => makeHandle(handlers, [], {
        ending: 'interrupted',
        error: new Error('raw mid-stream'),
      }),
    },
  });

  const handle = await service.send({ text: 'سلام' }, { onText: () => {} });
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'CHAT_LLM_MALFORMED_ERROR');
});

test('should_not_publish_message_completed_when_the_answer_fails', async () => {
  const { service, published } = createService({
    map: {
      stream: (messages, handlers) => makeHandle(handlers, [], {
        ending: 'interrupted',
        error: { code: 'LLM_REQUEST_FAILED', message: 'x', source: 'pey.llm', type: 'operational', timestamp: 't' },
      }),
    },
  });

  const handle = await service.send({ text: 'سلام' }, { onText: () => {} });
  await handle.done;

  assert.equal(published.filter((event) => event.type === 'chat:message-completed').length, 0);
});

test('should_register_no_answer_when_the_conversation_is_cleared_before_any_text', async () => {
  const gates = [createGate()];
  const { service, published } = createService({
    map: { stream: (messages, handlers) => makeHandle(handlers, ['دیررس'], { gates }) },
  });

  const handle = await service.send({ text: 'سلام' }, { onText: () => {} });
  service.clear();
  gates[0].open();
  const final = await handle.done;

  assert.equal(final.ending, 'cancelled');
  assert.deepEqual(service.getHistory(), [], 'the late answer must not register into the new conversation');
  assert.equal(published.filter((event) => event.type === 'chat:message-completed').length, 0);
});

test('should_register_no_late_answer_when_the_conversation_is_cleared_after_text', async () => {
  const gates = [createGate(), createGate()];
  let resolveFirst = null;
  const firstDelivered = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const { service } = createService({
    map: { stream: (messages, handlers) => makeHandle(handlers, ['اول', 'دیررس'], { gates }) },
  });

  const handle = await service.send({ text: 'سلام' }, { onText: () => resolveFirst?.() });
  gates[0].open();
  await firstDelivered;
  service.clear();
  gates[1].open();
  await handle.done;

  assert.deepEqual(service.getHistory(), [], 'nothing from the old generation may survive the clear');
});

test('should_reject_every_method_when_the_plugin_is_deactivated', async () => {
  const { service, deactivate } = createService({});

  deactivate();

  await assert.rejects(() => service.send({ text: 'سلام' }), (error) => error.code === 'SERVICE_UNAVAILABLE');
  await assert.rejects(() => service.retry(), (error) => error.code === 'SERVICE_UNAVAILABLE');
  assert.throws(() => service.stop(), (error) => error.code === 'SERVICE_UNAVAILABLE');
  assert.throws(() => service.clear(), (error) => error.code === 'SERVICE_UNAVAILABLE');
  assert.throws(() => service.getHistory(), (error) => error.code === 'SERVICE_UNAVAILABLE');
});

test('should_cancel_the_transport_and_deliver_no_delta_when_it_resolves_after_deactivation', async () => {
  // deactivate() cannot reach a transport that has not resolved yet: when
  // it finally does, the generation guard must cancel it immediately — the
  // request must not keep burning tokens, and no delta may reach the
  // caller's handler after deactivation.
  const gate = createGate();
  let delivered = [];
  let cancelCalls = 0;
  const { service, deactivate } = createService({
    map: {
      stream: (messages, handlers) => {
        const transport = makeHandle((handlers), ['دلتای دیرهنگام'], { gates: [gate] });
        const innerCancel = transport.cancel;
        transport.cancel = () => {
          cancelCalls += 1;
          innerCancel();
        };
        return transport;
      },
    },
  });

  const pending = service.send({ text: 'سلام' }, { onText: (text) => delivered.push(text) });
  deactivate();
  gate.open();
  const handle = await pending;
  const final = await handle.done;

  assert.equal(cancelCalls, 1, 'the late transport was cancelled on arrival');
  assert.deepEqual(delivered, [], 'no delta reached the caller after deactivation');
  assert.equal(final.ending, 'cancelled');
});

test('should_not_leave_an_unhandled_rejection_when_a_late_transport_done_rejects_after_deactivation', async () => {
  // The short-circuit path abandons the cancelled transport's done: its
  // rejection (contract break, connection death under the abort) must be
  // caught silently — an unhandled rejection would crash the host process.
  const gate = createGate();
  let cancelCalls = 0;
  const { service, deactivate } = createService({
    map: {
      stream: (messages, handlers) => {
        const transport = makeHandle(handlers, ['دلتای دیرهنگام'], { gates: [gate] });
        const innerCancel = transport.cancel;
        transport.cancel = () => {
          cancelCalls += 1;
          innerCancel();
        };
        transport.done = transport.done.then(() => {
          throw new Error('connection died under the abort');
        });
        return transport;
      },
    },
  });

  const pending = service.send({ text: 'سلام' }, { onText: () => {} });
  deactivate();
  gate.open();
  const handle = await pending;
  const final = await handle.done;

  assert.equal(cancelCalls, 1, 'the late transport was cancelled');
  assert.equal(final.ending, 'cancelled');
  // Give any unhandled rejection a tick to surface; the test runner fails
  // the whole run on one, so simply completing here is the assertion.
  await new Promise((resolve) => setImmediate(resolve));
});

test('should_not_leak_a_raw_error_when_a_broken_transport_done_getter_is_forgotten', async () => {
  // Reading a broken pey.llm object's `done` in the short-circuit path must
  // be as defended as its `cancel`: a throwing getter would otherwise break
  // the handle promise with a raw TypeError — a raw error across the
  // boundary that normalizeLlmError promises never happens.
  const gate = createGate();
  const { service, deactivate } = createService({
    map: {
      stream: (messages, handlers) => {
        const transport = makeHandle(handlers, ['دلتای دیرهنگام'], { gates: [gate] });
        Object.defineProperty(transport, 'done', {
          get() { throw new TypeError('broken pey.llm object'); },
        });
        return transport;
      },
    },
  });

  const pending = service.send({ text: 'سلام' }, { onText: () => {} });
  deactivate();
  gate.open();
  const handle = await pending;
  const final = await handle.done;

  assert.equal(final.ending, 'cancelled');
  await new Promise((resolve) => setImmediate(resolve));
});

test('should_not_announce_an_interrupted_ending_when_the_conversation_was_cleared_midway', async () => {
  // Same rule as the completed branch: an interrupted settlement landing
  // after clear()/deactivate() belongs to a dead generation — announcing it
  // would report an error for a message that exists in no history, so the
  // caller sees the same cancelled ending as every other late settlement.
  const gate = createGate();
  const { service } = createService({
    map: {
      stream: (messages, handlers) => ({
        cancel() {},
        done: (async () => {
          await gate.wait();
          return {
            ending: 'interrupted',
            error: { code: 'LLM_STREAM_INTERRUPTED', message: 'cut', source: 'pey.llm', type: 'operational', timestamp: 't' },
          };
        })(),
      }),
    },
  });

  const handle = await service.send({ text: 'سلام' }, { onText: () => {} });
  service.clear();
  gate.open();
  const final = await handle.done;

  assert.equal(final.ending, 'cancelled', 'the dead generation reports cancelled, not interrupted');
  assert.equal(final.error, undefined, 'no error is announced for a cleared conversation');
  assert.equal(service.getHistory().length, 0);
});

test('should_not_announce_an_interrupted_ending_when_a_cleared_conversations_done_rejects', async () => {
  // The reject path of a broken pey.llm done goes through the SAME
  // generation guard as the resolved interrupted ending: clear()/deactivate()
  // mid-generation must not surface the dead generation's error as an
  // interruption — the caller sees cancelled either way (deterministic in
  // the transport's manner of breaking).
  const gate = createGate();
  const { service } = createService({
    map: {
      stream: (messages, handlers) => ({
        cancel() {},
        done: (async () => {
          await gate.wait();
          throw new Error('connection died under the abort');
        })(),
      }),
    },
  });

  const handle = await service.send({ text: 'سلام' }, { onText: () => {} });
  service.clear();
  gate.open();
  const final = await handle.done;

  assert.equal(final.ending, 'cancelled', 'a dead generation reports cancelled on the reject path too');
  assert.equal(final.error, undefined);
  assert.equal(service.getHistory().length, 0);
});

test('should_map_a_done_that_resolves_to_an_invalid_value_when_the_transport_breaks_its_contract', async () => {
  // done RESOLVES to one of three endings by contract: a resolve to null
  // (or a primitive, or an ending-less object) used to die RAW on
  // `final.ending` — a TypeError crossing the boundary, breaking the
  // "three endings only" promise both the comment and the manifest make.
  const gate = createGate();
  for (const invalid of [null, undefined, 42, {}]) {
    const { service } = createService({
      map: {
        stream: () => ({
          cancel() {},
          done: (async () => {
            await gate.wait();
            return invalid;
          })(),
        }),
      },
    });

    const handle = await service.send({ text: 'سلام' }, { onText: () => {} });
    gate.open();
    const final = await handle.done;

    assert.equal(final.ending, 'interrupted', 'an invalid resolve is a contract break');
    assert.equal(final.error.code, 'CHAT_LLM_MALFORMED_ERROR', 'the break maps to the malformed code, never raw');
  }
});

test('should_map_an_unknown_ending_string_when_the_transport_invents_an_ending', async () => {
  // Exactly three endings are declared: an unknown ending STRING is a
  // contract break like any other — it must reach CHAT_LLM_MALFORMED_ERROR
  // through the same path, not fall through the branch chain into a silent
  // "cancelled" (which would make the transport's garbage indistinguishable
  // from a legitimate user cancellation).
  const gate = createGate();
  const { service } = createService({
    map: {
      stream: () => ({
        cancel() {},
        done: (async () => {
          await gate.wait();
          return { ending: 'boom' };
        })(),
      }),
    },
  });

  const handle = await service.send({ text: 'سلام' }, { onText: () => {} });
  gate.open();
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'CHAT_LLM_MALFORMED_ERROR');
});

test('should_map_a_throwing_ending_getter_when_the_transport_object_breaks_its_contract', async () => {
  // Reading a broken pey.llm object can throw in its own right: a throwing
  // `ending` getter used to escape done as a raw TypeError — done never
  // rejects, and nothing raw crosses the boundary. It maps like every
  // other contract break, and the generation guard still applies.
  const gate = createGate();
  const { service } = createService({
    map: {
      stream: () => ({
        cancel() {},
        done: (async () => {
          await gate.wait();
          return {
            get ending() { throw new TypeError('broken ending getter'); },
          };
        })(),
      }),
    },
  });

  const handle = await service.send({ text: 'سلام' }, { onText: () => {} });
  gate.open();
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted', 'done still resolves, never rejects');
  assert.equal(final.error.code, 'CHAT_LLM_MALFORMED_ERROR');

  // And for a dead generation the same break reports cancelled.
  const gate2 = createGate();
  const { service: service2 } = createService({
    map: {
      stream: () => ({
        cancel() {},
        done: (async () => {
          await gate2.wait();
          return {
            get ending() { throw new TypeError('broken ending getter'); },
          };
        })(),
      }),
    },
  });
  const handle2 = await service2.send({ text: 'سلام' }, { onText: () => {} });
  service2.clear();
  gate2.open();
  const final2 = await handle2.done;
  assert.equal(final2.ending, 'cancelled', 'a dead generation still reports cancelled');
});

test('should_map_a_transport_without_done_when_the_transport_breaks_its_contract', async () => {
  const { service } = createService({
    map: { stream: () => ({ cancel() {} }) },
  });

  const handle = await service.send({ text: 'سلام' }, { onText: () => {} });
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'CHAT_LLM_MALFORMED_ERROR');
});

test('should_leave_no_unhandled_rejection_when_a_non_caching_done_getter_hands_out_fresh_promises', async () => {
  // safeForgetDone must read `done` ONCE: a non-caching getter hands out a
  // fresh Promise per access, so a second read orphans the first promise's
  // rejection — the exact unhandled-rejection crash this helper exists to
  // prevent.
  const gate = createGate();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason));
  process.on('unhandledRejection', onUnhandled);
  try {
    const { service, deactivate } = createService({
      map: {
        stream: () => {
          const inner = { ending: 'cancelled' };
          let access = 0;
          return {
            cancel() {},
            get done() {
              access += 1;
              // A fresh rejecting promise per access; only the LAST read
              // ever gets its catch attached.
              return gate.wait().then(() => {
                if (access < 3) {
                  throw new Error(`orphaned rejection ${access}`);
                }
                return inner;
              });
            },
          };
        },
      },
    });

    const pending = service.send({ text: 'سلام' }, { onText: () => {} });
    deactivate();
    gate.open();
    const handle = await pending;
    await handle.done;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, [], 'every handed-out promise got its catch attached');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('should_deliver_no_delta_to_the_caller_when_the_conversation_is_cleared_midway', async () => {
  // clear() cuts the in-flight answer — the documented contract: deltas the
  // racing transport emits after the clear reach neither the history nor
  // the caller's handler, whose view was emptied on purpose (stop() never
  // bumps the generation, so its mid-stream deltas are unaffected).
  const gate = createGate();
  const { service } = createService({
    map: {
      stream: (messages, handlers) => makeHandle(handlers, ['دلتای پس از پاک‌سازی'], { gates: [gate] }),
    },
  });
  const delivered = [];
  const handle = await service.send({ text: 'سلام' }, { onText: (text) => delivered.push(text) });

  service.clear();
  gate.open();
  await handle.done;

  assert.deepEqual(delivered, [], 'no orphan delta reaches the caller after the clear');
  assert.equal(service.getHistory().length, 0);
});

test('should_fall_back_to_defaults_when_the_config_values_are_unusable', async () => {
  const { service, llm } = createService({
    config: { systemInstruction: 42, maxTurns: 0, maxChars: -5 },
  });

  const handle = await service.send({ text: 'سلام' }, { onText: () => {} });
  await handle.done;

  // Defaults: empty system instruction, 10 turns, 20000 chars — one turn
  // and no system message for this tiny conversation.
  const wire = wireTexts(llm.calls[0]);
  assert.equal(wire.length, 1);
  assert.equal(wire[0].role, 'user');
});

// --- second review pass: cancel/done boundary hygiene ----------------------

test('should_reject_with_a_structured_error_when_transport_done_rejects_raw', async () => {
  // The contract says done NEVER rejects: a broken pey.llm done promise
  // must land as a structured interruption, not a raw throw.
  const { service } = createService({
    map: {
      stream: () => ({
        cancel() {},
        done: Promise.reject(new Error('raw rejection from pey.llm')),
      }),
    },
  });

  const handle = await service.send({ text: 'سلام' }, { onText: () => {} });
  const final = await handle.done;

  assert.equal(final.ending, 'interrupted');
  assert.equal(final.error.code, 'CHAT_LLM_MALFORMED_ERROR');
});

test('should_swallow_a_throwing_cancel_when_stop_clear_and_deactivate_run_mid_stream', async () => {
  // The transport is what stop/clear/deactivate actually cancel: its done
  // is held open on a gate and its cancel is broken, so every swallowed
  // call is really exercised (counted), not a no-op on a nulled handle.
  const gate = createGate();
  let cancelCalls = 0;
  const { service, deactivate, published } = createService({
    map: {
      stream: (messages, handlers) => {
        const transport = makeHandle(handlers, ['پاسخ'], { gates: [gate] });
        transport.cancel = () => {
          cancelCalls += 1;
          throw new Error('pey.llm cancel is broken');
        };
        return transport;
      },
    },
  });

  await service.send({ text: 'سلام' }, { onText: () => {} });

  assert.doesNotThrow(() => service.stop(), 'a broken cancel must not cross stop');
  assert.doesNotThrow(() => service.clear(), 'a broken cancel must not cross clear');
  assert.doesNotThrow(() => deactivate(), 'a broken cancel must never reach teardown or the shutdown cycle');
  assert.ok(cancelCalls >= 1, 'the broken cancel was actually invoked');
  assert.equal(published.filter((event) => event.type === 'chat:history-cleared').length, 1);

  gate.open();
});

test('should_complete_the_answer_and_publish_the_event_when_deltas_land_after_attach', async () => {
  // Round-13 P0 regression: the settlement used to receive `registered` as
  // a VALUE snapshot taken at transport attach — but a real transport
  // delivers its deltas AFTER the attach, and the registration they
  // performed was invisible to the completed branch. The answer then sat
  // `incomplete` in history forever and chat:message-completed never fired
  // (the synchronous fake hid it; this gated fake reproduces the real
  // order). The flag must be read AT SETTLE TIME.
  let openGate = null;
  const gatePromise = new Promise((resolve) => { openGate = resolve; });
  const gate = { wait: () => gatePromise, open: openGate };
  const { service, published } = createService({
    map: {
      stream: (messages, handlers) => makeHandle(handlers, ['پاسخ'], { gates: [gate] }),
    },
  });

  const handle = await service.send({ text: 'سلام' });
  // The delta lands only now — after the transport attached.
  gate.open();
  const final = await handle.done;

  assert.equal(final.ending, 'completed');
  const history = service.getHistory();
  assert.equal(history[1].role, 'assistant');
  assert.equal(history[1].parts[0].text, 'پاسخ', 'the post-attach delta reached the answer');
  assert.equal(history[1].status, 'complete', 'the completed branch saw the live registration');
  const completions = published.filter((event) => event.type === 'chat:message-completed');
  assert.equal(completions.length, 1, 'exactly one completion event');
  assert.equal(completions[0].data.messageId, history[1].id);
});
