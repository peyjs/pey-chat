# pey.chat

[![AI](https://img.shields.io/badge/Built%20with-AI-blueviolet)](#)
[![version](https://img.shields.io/badge/version-1.0.0-blue.svg)](#)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Bonyan Architecture](https://img.shields.io/badge/bonyan-0.11-56c3bf)](https://github.com/barnevis/bonyan)

## Purpose

Feature plugin of the Pey ecosystem: conversation logic for a single in-memory chat with a language model — history, system instruction, per-message context, progressive answer delivery, stop and retry, and the sending-history cap. Holds no key and no connection settings; `pey.llm` owns those. Presentation stays with the UI.

## Structure

- `docs/requirements.md` — requirements; the construction source of truth.
- `manifest.json` — plugin contract (identity, service, events, config).
- `index.js` — Bonyan two-phase entry point (`prepare` / `activate`).
- `lib/constants.js` — plugin names, error codes, defaults.
- `lib/error.js` — standard Bonyan error factory.
- `lib/chat-history.js` — history normalization and the sending-history cap (trimming).
- `lib/chat-service.js` — conversation state, stop/retry.
- `tests/` — unit tests (`node:test`, fake `pey.llm` only).

## Dependencies

- **Required:** `pey.llm` (`pey.llm.service`).
- **Optional:** none.

## See Also

- [docs/requirements.md](docs/requirements.md) for the "what and why", written before the implementation.
- [docs/reference.md](docs/reference.md) for the full API, events, errors, config, business rules, and constraints.
