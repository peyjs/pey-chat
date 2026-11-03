# Changelog

## [1.0.0] - 1405-08-13

Initial release: single in-memory conversation logic for the chat capability stack — user messages with per-message context (stored with the message, sent to the model on every later turn), a configurable system instruction (counted in the sending budget, never dropped), progressive answer delivery through the shared flow pattern (three endings), stop that keeps the partial answer as incomplete, explicit retry with replace-on-first-text semantics, a sending-history cap trimmed by whole turns (displayed history untouched; the current message and the system instruction never dropped; no automatic shortening — `LLM_CONTEXT_TOO_LONG` passes through), and the `chat:message-completed` / `chat:history-cleared` events carrying ids only, never message text. Built on `pey.llm` 1.0.0; `docs/requirements.md` (numbered pey format) is the construction source of truth.
