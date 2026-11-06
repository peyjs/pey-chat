// Wires the chat service into Bonyan's two-phase plugin lifecycle.

import { LLM_SERVICE, PLUGIN_NAME, SERVICE_NAME } from './lib/constants.js';
import { createChatService } from './lib/chat-service.js';

const state = { llm: null, events: null, config: {} };
let savedContext = null;
let lifecycle = null;
let unsubscribeUnavailable = null;

/**
 * Releases this prepare() call's resources: the dependency reference and
 * the module-level handles go away and the core:service-unavailable
 * listener leaves the Event Bus, so a lost-dependency event after shutdown
 * can never report a critical error for a dead plugin.
 */
function teardown() {
  state.llm = null;
  lifecycle?.deactivate();
  lifecycle = null;
  savedContext = null;
  if (unsubscribeUnavailable !== null) {
    unsubscribeUnavailable();
    unsubscribeUnavailable = null;
  }
}

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
    source: PLUGIN_NAME,
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
  // A repeated prepare() call must not leave the previous call's listener
  // behind on the Event Bus.
  teardown();
  state.events = prepareContext.events ?? null;
  state.config = prepareContext.config ?? {};
  savedContext = prepareContext;
  const subscribed = prepareContext.events?.subscribe('core:service-unavailable', handleServiceUnavailable);
  unsubscribeUnavailable = typeof subscribed === 'function' ? subscribed : null;
  lifecycle = createChatService(state);
  prepareContext.onDeactivated = () => teardown();
  prepareContext.onShutdown = async () => teardown();
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
    // Boundary errors are always structured, startup included.
    throw Object.assign(new Error(`Required service is unavailable: ${LLM_SERVICE}`), {
      code: 'REQUIRED_DEPENDENCY_UNAVAILABLE',
      source: PLUGIN_NAME,
      type: 'startup',
      timestamp: new Date().toISOString(),
      detail: { service: LLM_SERVICE },
    });
  }
  state.llm = llm;
}
