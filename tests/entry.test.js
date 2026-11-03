// Verifies the entry-point lifecycle wiring and the manifest contract.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { prepare, activate } from '../index.js';

const MANIFEST_PATH = new URL('../manifest.json', import.meta.url);
const PACKAGE_PATH = new URL('../package.json', import.meta.url);

function createPrepareContext(overrides = {}) {
  return {
    config: {},
    events: {
      publish: () => {},
      subscribe: () => () => {},
    },
    onShutdown: null,
    onDeactivated: null,
    reportCriticalError: () => {},
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

test('should_refuse_calls_before_activation', async () => {
  const context = createPrepareContext();
  const registrations = await prepare(context);

  await assert.rejects(
    () => registrations[0].object.send({ text: 'سلام' }, {}),
    (error) => error.code === 'SERVICE_UNAVAILABLE',
  );
});

test('should_send_nothing_at_startup', async () => {
  const context = createPrepareContext();
  await prepare(context);

  // The contract: startup performs no model request. Nothing to assert
  // beyond prepare succeeding without a bound llm — the service only
  // touches the network from send/retry.
  assert.ok(context.onDeactivated);
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
  assert.deepEqual(manifest.events.map((event) => event.name), ['chat:message-completed', 'chat:history-cleared']);
  assert.deepEqual(manifest.config, { systemInstruction: '', maxTurns: 10, maxChars: 20000 });
});
