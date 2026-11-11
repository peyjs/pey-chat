# Changelog

## [1.0.2] - 1405-08-17

### Fixed

- Round 8: the raw-`pey.llm` boundary closes its last unguarded read — the short-circuit path's `done` access (a broken transport's throwing `done` getter crossed as a raw `TypeError` instead of being forgotten like its rejecting counterpart); an `interrupted` settlement for a generation whose conversation was cleared/reactivated mid-flight now reports `cancelled` like every other late settlement (no error announced for a message that exists in no history); and the deltas of a cancelled generation reach neither the history nor the caller's handler after `clear()`/`deactivate()` — the literal reading of "clearing cuts the in-flight answer" (three regression tests added).
- The raw-`pey.llm` boundary is now closed on every path: a rejecting `transport.done` lands as a structured interruption (done never rejects), and a throwing `transport.cancel` is swallowed at the handle, `stop`, `clear` and `deactivate` (it can never reach teardown or the shutdown cycle).
- `SERVICE_UNAVAILABLE` is declared in the manifest for `stop`, `clear` and `getHistory` (they refuse after deactivation like `send`/`retry`), and the manifest contract test now locks every method's error list.
- A `completed` ending for a generation whose conversation was cleared mid-flight no longer publishes `chat:message-completed` for a message that exists in no history.
- The stale `PLUGIN_VERSION` constant is gone; `normalizeLlmError` lives in `lib/error.js`; per-source test files added for `chat-history` and `constants`.
- A `retry` whose stream completes without a single delta no longer appends an empty assistant message under the previous answer: like the failure branch, the previous answer is kept and nothing is announced; only a fresh turn (history ending with the user message) registers the empty answer. The manifest and reference document this decision (dedicated tests added).
- The throwing-cancel test was rewritten to break the real transport cancel mid-stream (counted invocations) — the previous scenario exercised a nulled handle and could not fail; the dead `delayMs` fake option is gone and the duplicated code-prefix test was removed from `tests/error.test.js`.
- README and reference structure lists now include `lib/chat-history.js` (cap trimming lives there, not in `chat-service.js`), and the module is part of the published `exports` like the other `lib/*` modules.
- A transport cancelled on the short-circuit path (late arrival after clear/deactivate) has its abandoned `done` rejection caught silently — an unhandled rejection would crash the host process (regression test added, 58 tests).
- `tests/entry.test.js` renamed to `tests/index.test.js` so the test file mirrors its source (`index.js`).
- A transport resolving AFTER deactivation is cancelled on arrival through the generation guard and never delivers deltas to the caller (previously only stop/clear closed the pre-transport window; deactivate left the request running to completion) — regression test added (57 tests).
- The exports note moved out of the middle of the reference structure list and covers all four `lib/*` modules; the misnamed duplicate of the raw-interrupted-error test was removed (the contract test for a REJECTING `done` remains); the README version badge is now locked to the manifest by a contract test (55 tests).

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
