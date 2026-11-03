# pey.chat — Reference

Self-contained reference for the `pey.chat` feature plugin. The manifest (`manifest.json`) is always the authoritative contract; this document explains it.

## Purpose

Conversation logic for a single chat with a language model: history, the system instruction, per-message context, progressive answer delivery, stop and retry, and the sending-history cap. The plugin never touches the network itself and never sees the key or the connection settings — `pey.llm` owns those. Presentation (rendering, formatting, inserting the answer into a document) stays with the UI.

## Structure

- `manifest.json` — plugin contract (identity, service, events, config).
- `index.js` — Bonyan two-phase entry point (`prepare` / `activate`).
- `lib/constants.js` — plugin name, service name, error codes, defaults.
- `lib/error.js` — standard Bonyan error factory.
- `lib/chat-service.js` — conversation state, cap trimming, stop/retry.
- `tests/` — unit tests (`node:test`, fake `pey.llm` only).

## Dependencies

- **Required:** `pey.llm.service` — bound at activation; if it disappears at runtime the plugin reports `REQUIRED_DEPENDENCY_LOST`.
- **Optional:** none (persistence of history is a later step and will come with an optional storage dependency).

## Public API

The service `pey.chat.service` provides five methods. One conversation exists, in memory; it starts empty and `clear()` empties it.

### `send({ text, context? }, { onText })`

Appends the user message (with optional context, e.g. the selection of a document) and starts generating the answer. Text is delivered progressively through `onText` as it arrives. The handle follows the shared flow pattern: `done` never rejects and resolves exactly one of three endings:

- `{ ending: 'completed' }` — the answer finished and was registered in history; `chat:message-completed` carried its id.
- `{ ending: 'interrupted', error }` — a mid-way failure; the partial text received so far stays in history marked `incomplete`, and the `pey.llm` error passes through unchanged.
- `{ ending: 'cancelled' }` — the caller (or `stop()`) cancelled; the partial text stays `incomplete`.

A send while an answer is being generated is rejected with `CHAT_RESPONSE_IN_PROGRESS` — stop the current one first. Empty or blank text is rejected with `CHAT_EMPTY_MESSAGE`.

The context travels with its message: it counts toward that message's size, is stored in history (and visible via `getHistory`), and is sent to the model with that message in every later turn.

### `stop()`

Cancels the answer currently being generated (a no-op when nothing is in flight). The partial text received so far stays in history marked `incomplete`.

### `retry({ onText })`

Regenerates the answer for the **last user message** without repeating the message. Never automatic — every retry is an explicit caller request. Replacement semantics:

- The previous answer (complete, incomplete or failed) stays untouched until the first new text arrives; then the new answer takes its place.
- A failure before any text keeps the previous answer and surfaces the error.
- A mid-way failure or a stop replaces the previous answer with the received partial, marked `incomplete`.

No user message in history → `CHAT_NO_RETRY_TARGET`.

### `clear()`

Empties the conversation and publishes `chat:history-cleared`.

### `getHistory()`

Returns a read-only copy of the conversation: `{ id, role, parts, status, at }` per message — the user's message carries its `context` in its text part. The displayed history is never trimmed; the sending-history cap (below) affects only what goes to the model.

## The sending-history cap

Configured as `maxTurns` (whole turns) and `maxChars` (total characters), both estimated on characters, not tokens. When building the payload for the model:

- A **turn** is one user message plus the answer(s) that follow it; trimming always drops whole turns, oldest first, and only from what goes to the model.
- The **system instruction** is counted in the characters (it goes to the model) but never dropped.
- The **current message** is never dropped.
- If the system instruction and the current message alone exceed the cap, nothing is dropped and the request is sent anyway; if the model refuses, `LLM_CONTEXT_TOO_LONG` reaches the UI unchanged — the plugin never shortens anything by itself.
- An `incomplete` answer goes to the model like any other history entry (the user has seen it and the next question may refer to it).

## Events

| Event | Data | When |
|---|---|---|
| `chat:message-completed` | `{ messageId }` | An assistant answer was registered completely. |
| `chat:history-cleared` | none | The conversation was cleared. |

Message text and context never appear in events or errors — events carry ids only.

## Errors Reference

| Code | Situation | Type |
|---|---|---|
| `CHAT_EMPTY_MESSAGE` | The message text is missing, empty or blank. | operational |
| `CHAT_RESPONSE_IN_PROGRESS` | A send or retry arrived while an answer was being generated. | operational |
| `CHAT_NO_RETRY_TARGET` | Retry was requested but no user message exists. | operational |
| `LLM_*` / `HTTP_*` | Passed through unchanged from `pey.llm` (including `LLM_CONTEXT_TOO_LONG` — no automatic shortening happens here). | operational |
| `SERVICE_UNAVAILABLE` | Called before activation or after deactivation/shutdown. | operational |

Branch on `code`, never on `message`.

## Config

| Key | Type | Required | Default | Purpose |
|---|---|---|---|---|
| `systemInstruction` | `string` | No | `''` | Sent with every request; never shown in history; never dropped by the cap. |
| `maxTurns` | `number` | No | `10` | Sending-history cap in whole turns. |
| `maxChars` | `number` | No | `20000` | Sending-history cap in characters (estimate; conservative default — the char/token ratio is not linear for Persian). |

## Business Rules

- Startup sends nothing; the plugin only acts from `send`/`retry`.
- After every ending — ordinary, error or cancel — the response lock is freed, so consecutive failures never wedge the conversation.
- Retry is never automatic; the previous answer survives until new text arrives.
- No message text or context in events, errors or logs.
- This plugin never formats or renders the answer, never inserts it into a document, and never stores the conversation persistently (a later step adds an optional storage dependency).

## Constraints

- Exactly one conversation, in memory, for this step; persistence and multiple conversations are out of scope.
- Do not use this service as an LLM client for non-conversation tasks — use `pey.llm` directly.
