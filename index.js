// Wires the chat service into Bonyan's two-phase plugin lifecycle.

import { LLM_SERVICE, SERVICE_NAME } from './lib/constants.js';
import { createChatService } from './lib/chat-service.js';

const state = { llm: null, events: null, config: {} };
let savedContext = null;
let lifecycle = null;

/**
 * Reports a critical error when the required LLM service disappears at
 * runtime. Settlement already handles startup-time absence automatically.
 * @param {object} event Core event envelope.
 * @returns {void}
 */
function handleServiceUnavailable(event) {
  if (event?.data?.serviceName !== LLM_SERVICE || !savedContext) {
    return;
  }
  savedContext.reportCriticalError({
    code: 'REQUIRED_DEPENDENCY_LOST',
    message: `Required service ${LLM_SERVICE} is no longer available`,
    source: SERVICE_NAME,
    type: 'critical',
    timestamp: new Date().toISOString(),
  });
}

/**
 * Prepares the plugin: builds the service and registers lifecycle hooks.
 * Nothing is sent at startup; the pey.llm dependency is bound at activation.
 * @param {object} prepareContext Bonyan preparation context.
 * @returns {Promise<Array>} Service registration.
 */
export async function prepare(prepareContext) {
  state.llm = null;
  state.events = prepareContext.events ?? null;
  state.config = prepareContext.config ?? {};
  savedContext = prepareContext;
  prepareContext.events?.subscribe('core:service-unavailable', handleServiceUnavailable);
  lifecycle = createChatService(state);
  prepareContext.onDeactivated = () => {
    state.llm = null;
    lifecycle?.deactivate();
  };
  prepareContext.onShutdown = async () => {
    state.llm = null;
    lifecycle?.deactivate();
  };
  return [{ name: SERVICE_NAME, object: lifecycle.service }];
}

/**
 * Activates the plugin: binds the required LLM service for service calls.
 * @param {Record<string, object>} services Bound declared dependencies.
 * @returns {Promise<void>}
 */
export async function activate(services) {
  const llm = services[LLM_SERVICE];
  if (!llm) {
    throw new Error(`Required service is unavailable: ${LLM_SERVICE}`);
  }
  state.llm = llm;
}
