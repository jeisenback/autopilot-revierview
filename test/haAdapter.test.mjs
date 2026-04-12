import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHaAdapter } from '../orchestrator/haAdapter.mjs';

// ─── stubs ────────────────────────────────────────────────────────────────────

function stubFetch(response) {
  let callCount = 0;
  const fn = async () => {
    callCount++;
    return response;
  };
  fn.callCount = () => callCount;
  return fn;
}

function okFetch(states) {
  return stubFetch({
    ok: true,
    json: async () => states,
  });
}

function failFetch(err = new Error('fetch failed')) {
  let callCount = 0;
  const fn = async () => { callCount++; throw err; };
  fn.callCount = () => callCount;
  return fn;
}

function notOkFetch(status = 401) {
  return stubFetch({ ok: false, status });
}

// Sample HA API response format
const HA_STATES = [
  { entity_id: 'sensor.weather_forecast', state: 'sunny', attributes: { temperature: 72 } },
  { entity_id: 'binary_sensor.front_door', state: 'off', attributes: {} },
  { entity_id: 'sensor.water_leak_kitchen', state: 'dry', attributes: {} },
];

// ─── tests ────────────────────────────────────────────────────────────────────

test('getStates(): valid response → returns array of matching entities', async () => {
  const adapter = createHaAdapter({
    fetch: okFetch(HA_STATES),
    baseUrl: 'http://homeassistant.local:8123',
    token: 'test-token',
  });

  const result = await adapter.getStates(['sensor.weather_forecast', 'binary_sensor.front_door']);
  assert.ok(Array.isArray(result), 'result should be an array');
  assert.equal(result.length, 2);
  assert.ok(result.some(e => e.entity_id === 'sensor.weather_forecast'));
  assert.ok(result.some(e => e.entity_id === 'binary_sensor.front_door'));
});

test('getStates(): filters to only requested entityIds', async () => {
  const adapter = createHaAdapter({
    fetch: okFetch(HA_STATES),
    baseUrl: 'http://homeassistant.local:8123',
    token: 'test-token',
  });

  const result = await adapter.getStates(['sensor.weather_forecast']);
  assert.equal(result.length, 1);
  assert.equal(result[0].entity_id, 'sensor.weather_forecast');
  assert.equal(result[0].state, 'sunny');
});

test('getStates(): HA unreachable (fetch throws) → returns [] without throwing', async () => {
  const adapter = createHaAdapter({
    fetch: failFetch(new Error('ECONNREFUSED')),
    baseUrl: 'http://homeassistant.local:8123',
    token: 'test-token',
  });

  const result = await adapter.getStates(['sensor.weather_forecast']);
  assert.deepEqual(result, []);
});

test('getStates(): HA returns non-ok status → returns [] without throwing', async () => {
  const adapter = createHaAdapter({
    fetch: notOkFetch(401),
    baseUrl: 'http://homeassistant.local:8123',
    token: 'test-token',
  });

  const result = await adapter.getStates(['sensor.weather_forecast']);
  assert.deepEqual(result, []);
});

test('getStates(): empty entityIds array → returns [] immediately, no HTTP call', async () => {
  const fetcher = okFetch(HA_STATES);
  const adapter = createHaAdapter({
    fetch: fetcher,
    baseUrl: 'http://homeassistant.local:8123',
    token: 'test-token',
  });

  const result = await adapter.getStates([]);
  assert.deepEqual(result, []);
  assert.equal(fetcher.callCount(), 0, 'no HTTP call should be made for empty entity list');
});

test('getStates(): Authorization header set correctly', async () => {
  let capturedOptions;
  const captureFetch = async (url, options) => {
    capturedOptions = options;
    return { ok: true, json: async () => HA_STATES };
  };
  const adapter = createHaAdapter({
    fetch: captureFetch,
    baseUrl: 'http://homeassistant.local:8123',
    token: 'my-secret-token',
  });

  await adapter.getStates(['sensor.weather_forecast']);
  assert.equal(capturedOptions.headers.Authorization, 'Bearer my-secret-token');
});

test('getStates(): timeout AbortSignal passed to fetch', async () => {
  let capturedOptions;
  const captureFetch = async (url, options) => {
    capturedOptions = options;
    return { ok: true, json: async () => [] };
  };
  const adapter = createHaAdapter({
    fetch: captureFetch,
    baseUrl: 'http://homeassistant.local:8123',
    token: 'test-token',
    timeoutMs: 5000,
  });

  await adapter.getStates(['sensor.weather_forecast']);
  assert.ok(capturedOptions.signal instanceof AbortSignal, 'AbortSignal should be passed');
});
