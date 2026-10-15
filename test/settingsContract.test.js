const assert = require('node:assert/strict');
const test = require('node:test');
const manifest = require('../package.json');
const { SETTINGS, GLOBAL_SETTINGS, settingScope, defaultConfig, listConfig, getConfigValue, setConfigValue } = require('../service/out/configStore');

/**
 * The contract between package.json's `aiUsage.*` settings and the service's engine settings. configSync.test.js
 * covers the sync mechanics and configStore.test.js the schema itself; this checks that the two declarations
 * cannot drift apart (a wrong scope makes a remote window read Remote settings while User values are ignored).
 */
const declared = Object.assign({}, ...manifest.contributes.configuration.map(block => block.properties));
const settings = Object.entries(declared).map(([name, spec]) => [name.replace(/^aiUsage\./, ''), spec]);
const engine = listConfig(defaultConfig());
const engineByKey = new Map(engine.map(entry => [entry.key, entry]));

/** Documented exceptions to the rules below; each is a real deviation found when this test was written. */
const KNOWN_DEVIATIONS = {
  // The service schema allows a quarter minute for both providers, Codex's package.json minimum is one minute
  // (the schema description says "Codex at least one"); the service does not enforce it.
  'minimum:codex.checkIntervalMinutes': 'package.json minimum 1 vs service schema 0.25',
  // Engine settings that are window-scoped on purpose are listed here; none today.
};
const deviation = (kind, key) => Object.hasOwn(KNOWN_DEVIATIONS, `${kind}:${key}`);

/** Settings that exist only in package.json (no service counterpart): none are allowed, every key is mirrored. */
const PACKAGE_ONLY = new Set([]);

test('every package.json aiUsage setting is an engine key or classified as presentation, local or workspace', () => {
  assert.ok(settings.length > 50, 'the manifest declares its settings');
  for (const [key] of settings) {
    if (PACKAGE_ONLY.has(key)) continue;
    assert.ok(engineByKey.has(key), `${key} is declared in package.json but unknown to the service`);
    assert.ok(['engine', 'presentation', 'local', 'workspace'].includes(settingScope(key)), key);
  }
});

test('every service setting is declared in package.json', () => {
  for (const { key } of engine) assert.ok(Object.hasOwn(declared, `aiUsage.${key}`), `${key} exists in the service but not in package.json`);
  for (const schema of [...SETTINGS, ...GLOBAL_SETTINGS]) assert.ok(schema.key && schema.description, 'schema entries are complete');
});

test('engine settings are machine-scoped so a remote window cannot shadow User values', () => {
  const engineKeys = settings.filter(([key]) => settingScope(key) === 'engine');
  assert.ok(engineKeys.length > 40, 'most settings are engine settings');
  for (const [key, spec] of engineKeys) {
    if (deviation('scope', key)) continue;
    assert.equal(spec.scope, 'machine', `${key} drives the service and must have "scope": "machine"`);
  }
});

test('package.json defaults equal the service defaults', () => {
  const defaults = defaultConfig();
  const read = (key) => key.split('.').reduce((value, part) => value?.[part], defaults);
  for (const { key, value } of engine) {
    const spec = declared[`aiUsage.${key}`];
    if (!spec || spec.default === undefined || deviation('default', key)) continue;
    assert.deepEqual(read(key), spec.default, `${key}: service default differs from package.json`);
    assert.deepEqual(value, spec.default, `${key}: listed default differs from package.json`);
  }
});

test('minimum and maximum agree in both directions', () => {
  for (const { key, schema } of engine) {
    const spec = declared[`aiUsage.${key}`];
    if (!spec) continue;
    for (const [kind, packageValue, schemaValue] of [['minimum', spec.minimum, schema.min], ['maximum', spec.maximum, schema.max]]) {
      if (deviation(kind, key)) continue;
      assert.equal(packageValue, schemaValue, `${key}: package.json ${kind} ${packageValue} vs service ${schemaValue}`);
    }
  }
});

test('types and enum values agree', () => {
  for (const { key, schema } of engine) {
    const spec = declared[`aiUsage.${key}`];
    if (!spec || deviation('type', key)) continue;
    const types = [].concat(spec.type);
    assert.equal(types.includes('null'), Boolean(schema.nullable), `${key}: nullability differs`);
    const expected = spec.enum ? 'enum' : types.find(type => type !== 'null');
    assert.equal(schema.type, expected, `${key}: type differs`);
    if (spec.enum) assert.deepEqual(schema.values, spec.enum, `${key}: enum values differ`);
    else assert.equal(schema.values, undefined, `${key}: service enum has no package.json enum`);
  }
});

test('the known deviations are still real', () => {
  // A fixed deviation must be removed from the list, so the list never rots.
  for (const name of Object.keys(KNOWN_DEVIATIONS)) {
    const [kind, key] = name.split(':');
    const entry = engineByKey.get(key);
    const spec = declared[`aiUsage.${key}`];
    assert.ok(entry && spec, `${name} refers to a setting that no longer exists`);
    if (kind === 'minimum') assert.notEqual(spec.minimum, entry.schema.min, `${name} no longer deviates`);
    if (kind === 'maximum') assert.notEqual(spec.maximum, entry.schema.max, `${name} no longer deviates`);
  }
});

test('every VS Code setting is also a validated standalone CLI setting, with identical defaults', () => {
  const manifest = require('../package.json'); const config = defaultConfig();
  for (const block of manifest.contributes.configuration) for (const [key, schema] of Object.entries(block.properties)) {
    const dotted = key.replace(/^aiUsage\./, '');
    assert.deepEqual(getConfigValue(config, dotted), schema.default, key);
    if (schema.default !== undefined) assert.deepEqual(getConfigValue(setConfigValue(config, dotted, schema.default), dotted), schema.default);
  }
  assert.equal(getConfigValue(setConfigValue(config, 'codexConfig.agents.maxDepth', 'null'), 'codexConfig.agents.maxDepth'), null);
  assert.deepEqual(getConfigValue(setConfigValue(config, 'accounts', '[{"name":"test"}]'), 'accounts'), [{ name: 'test' }]);
});
