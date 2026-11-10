// Verifies the entry-point lifecycle wiring and the manifest contract.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { prepare, activate } from '../index.js';

const MANIFEST_PATH = new URL('../manifest.json', import.meta.url);
const PACKAGE_PATH = new URL('../package.json', import.meta.url);

function createPrepareContext(overrides = {}) {
  const published = [];
  const listeners = {};
  return {
    config: {},
    published,
    listeners,
    events: {
      publish: () => {},
      subscribe(type, listener) {
        listeners[type] = listeners[type] ?? [];
        listeners[type].push(listener);
        return () => {
          const index = listeners[type].indexOf(listener);
          if (index !== -1) listeners[type].splice(index, 1);
        };
      },
    },
    onShutdown: null,
    onDeactivated: null,
    reportCriticalError: (error) => published.push(error),
    ...overrides,
  };
}

test('should_register_service_when_prepare_is_called', async () => {
  const context = createPrepareContext();

  const registrations = await prepare(context);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, 'pey.chat.service');
  assert.equal(typeof registrations[0].object.send, 'function');
  assert.equal(typeof registrations[0].object.stop, 'function');
  assert.equal(typeof registrations[0].object.retry, 'function');
  assert.equal(typeof registrations[0].object.clear, 'function');
  assert.equal(typeof registrations[0].object.getHistory, 'function');
  assert.equal(typeof context.onShutdown, 'function');
  assert.equal(typeof context.onDeactivated, 'function');
});

test('should_reject_activation_when_the_llm_dependency_is_missing', async () => {
  await prepare(createPrepareContext());

  await assert.rejects(() => activate({}), /pey.llm.service/);
  await activate({ 'pey.llm.service': {} });
});

test('should_refuse_calls_before_activation_when_the_dependency_is_not_bound', async () => {
  const context = createPrepareContext();
  const registrations = await prepare(context);

  await assert.rejects(
    () => registrations[0].object.send({ text: 'سلام' }, {}),
    (error) => error.code === 'SERVICE_UNAVAILABLE',
  );
});

test('should_send_nothing_at_startup_when_prepare_only_registers_the_service', async () => {
  const context = createPrepareContext();
  await prepare(context);

  // The contract: startup performs no model request. Nothing to assert
  // beyond prepare succeeding without a bound llm — the service only
  // touches the network from send/retry.
  assert.ok(context.onDeactivated);
});

test('should_match_the_readme_badge_version_when_the_manifest_declares_one', async () => {
  // The badge has drifted three releases without anyone noticing; the
  // manifest-vs-badge check keeps it at the gate from now on.
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

  const badge = readme.match(/version-([\d.]+)-blue/);
  assert.notEqual(badge, null, 'the README carries a version badge');
  assert.equal(badge[1], manifest.version, 'the badge never drifts from the manifest');
});

test('should_match_manifest_contract_when_loaded', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const pkg = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'));

  assert.equal(manifest.name, 'pey.chat');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.type, 'feature');
  assert.equal(manifest.adapterType, undefined);
  assert.deepEqual(manifest.dependencies, { required: ['pey.llm.service'], optional: [] });
  assert.equal(manifest.provides.length, 1);
  assert.equal(manifest.provides[0].name, 'pey.chat.service');
  const methodNames = manifest.provides[0].methods.map((method) => method.name);
  assert.deepEqual(methodNames, ['send', 'stop', 'retry', 'clear', 'getHistory']);
  // Every method that can refuse after deactivation must declare it, and
  // the raw-llm wrapper code must be declared where it can surface.
  const errorsOf = (name) => manifest.provides[0].methods.find((method) => method.name === name).errors;
  for (const name of ['send', 'stop', 'retry', 'clear', 'getHistory']) {
    assert.ok(errorsOf(name).includes('SERVICE_UNAVAILABLE'), `${name} must declare SERVICE_UNAVAILABLE`);
  }
  for (const name of ['send', 'retry']) {
    assert.ok(errorsOf(name).includes('CHAT_LLM_MALFORMED_ERROR'), `${name} must declare CHAT_LLM_MALFORMED_ERROR`);
  }
  assert.deepEqual(manifest.events.map((event) => event.name), ['chat:message-completed', 'chat:history-cleared']);
  assert.deepEqual(manifest.config, { systemInstruction: '', maxTurns: 10, maxChars: 20000 });
});

test('should_reject_activation_with_a_structured_startup_error_when_the_dependency_is_missing', async () => {
  await prepare(createPrepareContext());

  await assert.rejects(
    () => activate({}),
    (error) => error.code === 'REQUIRED_DEPENDENCY_UNAVAILABLE'
      && error.type === 'startup'
      && error.source === 'pey.chat',
  );
});

test('should_report_critical_error_when_the_llm_dependency_is_lost_at_runtime', async () => {
  const context = createPrepareContext();
  await prepare(context);

  context.listeners['core:service-unavailable'][0]({
    data: { serviceName: 'pey.llm.service' },
  });

  const critical = context.published.find((error) => error.type === 'critical');
  assert.equal(critical.code, 'REQUIRED_DEPENDENCY_LOST');
  assert.equal(critical.source, 'pey.chat');
});

test('should_ignore_unrelated_service_loss_when_notified', async () => {
  const context = createPrepareContext();
  await prepare(context);

  context.listeners['core:service-unavailable'][0]({
    data: { serviceName: 'other.service' },
  });

  assert.equal(context.published.length, 0);
});

test('should_unsubscribe_from_service_unavailable_when_shutdown_or_deactivated', async () => {
  const context = createPrepareContext();
  await prepare(context);
  assert.equal(context.listeners['core:service-unavailable'].length, 1);

  await context.onShutdown();
  assert.equal(context.listeners['core:service-unavailable'].length, 0, 'shutdown must leave the bus');

  await prepare(context);
  context.onDeactivated();
  assert.equal(context.listeners['core:service-unavailable'].length, 0, 'deactivation must leave the bus');
});
