# Changelog

## [1.0.1] - 1405-08-15

### Fixed

- The system instruction now counts **inside** the `maxChars` budget (system + history together), matching the requirement wording; previously the effective budget was `maxChars + systemChars`.
- Raw errors from `pey.llm` no longer cross the boundary: structured errors (`code` + `source`) pass through unchanged, anything else is wrapped as `CHAT_LLM_MALFORMED_ERROR` — including a synchronous throw from `llm.stream` and raw mid-stream errors.
- All five methods (`send`, `stop`, `retry`, `clear`, `getHistory`) refuse with `SERVICE_UNAVAILABLE` after deactivation/shutdown.
- The `core:service-unavailable` subscription is released on shutdown/deactivation (and on a repeated `prepare()`); module-level `savedContext`/`lifecycle` are nulled; a missing dependency at activation throws a structured startup error; the critical report's `source` is the plugin name.
- A generation (epoch) guard closes the narrow window after `clear()`: a late answer can never register into the new conversation.
- Message ids use `crypto.randomUUID` where available; `send` checks the response lock before the empty-text check; history shaping moved to `lib/chat-history.js`.
- Test fakes replaced real timers with deterministic gates; new tests cover raw-error wrapping, the post-clear registration guard, post-deactivation refusal, the missing critical report, no `chat:message-completed` on failure, and config fallback; test names normalized to `should_…_when_…` and `tests/error.test.js` added (42 tests).

## [1.0.0] - 1405-08-13

Initial release: single in-memory conversation logic for the chat capability stack — user messages with per-message context (stored with the message, sent to the model on every later turn), a configurable system instruction (counted in the sending budget, never dropped), progressive answer delivery through the shared flow pattern (three endings), stop that keeps the partial answer as incomplete, explicit retry with replace-on-first-text semantics, a sending-history cap trimmed by whole turns (displayed history untouched; the current message and the system instruction never dropped; no automatic shortening — `LLM_CONTEXT_TOO_LONG` passes through), and the `chat:message-completed` / `chat:history-cleared` events carrying ids only, never message text. Built on `pey.llm` 1.0.0; `docs/requirements.md` (numbered pey format) is the construction source of truth.
