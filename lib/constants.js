// Shared constants for the pey.chat plugin.

export const PLUGIN_NAME = 'pey.chat';
export const SERVICE_NAME = 'pey.chat.service';
export const LLM_SERVICE = 'pey.llm.service';

export const ERROR_CODES = Object.freeze({
  EMPTY_MESSAGE: 'CHAT_EMPTY_MESSAGE',
  RESPONSE_IN_PROGRESS: 'CHAT_RESPONSE_IN_PROGRESS',
  NO_RETRY_TARGET: 'CHAT_NO_RETRY_TARGET',
  LLM_MALFORMED_ERROR: 'CHAT_LLM_MALFORMED_ERROR',
});

export const SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE';

export const MESSAGE_COMPLETED_EVENT = 'chat:message-completed';
export const HISTORY_CLEARED_EVENT = 'chat:history-cleared';

export const DEFAULT_SYSTEM_INSTRUCTION = '';
export const DEFAULT_MAX_TURNS = 10;
export const DEFAULT_MAX_CHARS = 20000;
