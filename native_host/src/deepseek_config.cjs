// Source for the standalone native_host/deepseek_config.cjs bundle.
// YAML tags (including Harness !!js expressions) are retained as data, never executed.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const YAML = require('yaml');
const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const ROUTER_KEY = 'router';
const ROUTER_ID = 'codexswitch-router';
const ROUTER_API_KEY_ENV = 'CODEXSWITCH_ROUTER_KEY';
const DIRECT_API_KEY_ENV = 'DEFAULT_API_KEY';

function resolveDeepSeekHarnessPaths(config = {}) {
  const profile = String(config.profile || 'desktop');
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(profile)) throw new Error('Invalid DeepSeek Harness profile');
  const dshHome = path.resolve(config.dshHome || config.DSH_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  return { dshHome, profile, patchFile: path.join(dshHome, 'profiles', profile, 'cordis.patch.yml'), credentialsFile: path.join(dshHome, '.credentials.yaml') };
}
function protocol(value) {
  const aliases = { chat: PROTOCOLS[0], completions: PROTOCOLS[0], chatcompletions: PROTOCOLS[0], 'chat-completions': PROTOCOLS[0], openai: PROTOCOLS[0], responses: PROTOCOLS[1], messages: PROTOCOLS[2], anthropic: PROTOCOLS[2] };
  const api = aliases[value] || value;
  if (!PROTOCOLS.includes(api)) throw new Error(`Unsupported DeepSeek Harness protocol: ${value}`);
  return api;
}
/**
 * The first provider mapping in the patch file is the managed one. Router mode
 * points that entry at the local router; direct mode writes the enabled
 * provider's values into the very same entry.
 */
function normalize(config) {
  const id = String(config.providerId || config.provider || 'deepseek');
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('Invalid DeepSeek provider ID');
  const router = config.router === true || config.providerId === ROUTER_ID;
  const baseURL = String(config.baseURL || config.baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseURL)) throw new Error('DeepSeek baseURL must use http or https');
  new URL(baseURL);
  const rawProtocol = config.api || config.protocol || config.defaultProtocol || (Array.isArray(config.protocols) ? config.protocols[0] : config.protocols) || PROTOCOLS[0];
  const api = protocol(rawProtocol);
  const rawModels = config.models?.length ? config.models : [config.model || ROUTER_KEY];
  const models = [];
  for (const model of rawModels) {
    const entry = typeof model === 'string' ? { id: model } : model;
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) throw new Error('DeepSeek models must contain non-empty id values');
    if (!models.some(existing => existing.id === entry.id)) models.push({ ...entry, name: entry.id });
  }
  if (!models.length) throw new Error('DeepSeek models must contain non-empty id values');
  const providerKey = String(config.providerKey || (router ? ROUTER_KEY : id));
  if (!/^[A-Za-z0-9._-]+$/.test(providerKey)) throw new Error('Invalid DeepSeek provider ID');
  // Direct switches share Harness's default credential slot; only router mode
  // uses the local token slot, so routing never overwrites the upstream key.
  const apiKeyEnv = String(config.apiKeyEnv || (router ? ROUTER_API_KEY_ENV : DIRECT_API_KEY_ENV));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error('Invalid DeepSeek apiKeyEnv');
  const model = String(config.model || models[0].id);
  if (!models.some(entry => entry.id === model)) throw new Error('Selected DeepSeek model is missing from the managed provider');
  // Anthropic's SDK appends /v1/messages; OpenAI's SDK appends /chat/completions or /responses.
  const routeBaseURL = api === 'anthropic-messages' ? baseURL.replace(/\/v1$/i, '') : baseURL;
  return {
    providerKey,
    displayName: router ? ROUTER_KEY : String(config.name || config.displayName || id),
    api,
    baseURL: routeBaseURL,
    apiKeyEnv,
    model,
    models,
    router,
  };
}
/** Keys this tool may have written before, so a stale variant never shadows the managed entry. */
function managedKeys(id) {
  const keys = [ROUTER_KEY, ROUTER_ID, id];
  for (const api of PROTOCOLS) keys.push(`${id}-${api}`, `${ROUTER_ID}-${api}`);
  return new Set(keys);
}
function parse(text, label, empty) {
  const doc = YAML.parseDocument(text || empty, { uniqueKeys: true, customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  if (doc.errors.length) throw new Error(`Invalid ${label} YAML: ${doc.errors[0].message}`);
  return doc;
}
function mapping(doc, parent, key) {
  let node = parent.get(key, true);
  if (node === undefined) { node = doc.createNode({}); parent.set(key, node); }
  if (!YAML.isMap(node)) throw new Error(`DeepSeek ${key} must be a YAML mapping`);
  return node;
}
function plugin(doc, id) {
  let found;
  function visit(seq) {
    for (const node of seq.items) {
      if (!YAML.isMap(node)) throw new Error('DeepSeek patch entries must be YAML mappings');
      if (node.get('id') === id || node.get('name') === `@deepseek-ai/dsh-${id}`) found = node;
      const insert = node.get('insert', true);
      if (YAML.isSeq(insert)) visit(insert);
    }
  }
  visit(doc.contents);
  if (!found) { found = doc.createNode({ id, name: `@deepseek-ai/dsh-${id}` }); doc.contents.add(found); }
  return mapping(doc, found, 'config');
}
/**
 * The first provider entry always stays first: its key is renamed in place so
 * Harness shows the managed upstream at the top of the list.
 */
function managedProvider(doc, providers, entry) {
  const stale = managedKeys(entry.providerKey);
  const pairs = providers.items;
  const first = pairs[0];
  let node = first ? first.value : undefined;
  if (node !== undefined && !YAML.isMap(node)) throw new Error('DeepSeek provider entries must be YAML mappings');
  if (first && String(first.key) !== entry.providerKey) first.key = doc.createNode(entry.providerKey);
  // Previous builds wrote one mapping per protocol; drop those managed duplicates.
  providers.items = pairs.filter((pair, index) => index === 0 || !stale.has(String(pair.key)));
  if (node === undefined) { node = doc.createNode({}); providers.set(entry.providerKey, node); }
  return node;
}
function render(config, oldPatch, oldCredentials) {
  const entry = normalize(config);
  const patch = parse(oldPatch, 'patch', '[]');
  const credentials = parse(oldCredentials, 'credentials', 'version: 1\nrefs: {}\n');
  if (!YAML.isSeq(patch.contents)) throw new Error('DeepSeek patch must be a YAML sequence');
  if (!YAML.isMap(credentials.contents)) throw new Error('DeepSeek credentials must be a YAML mapping');
  if (credentials.get('version') !== undefined && credentials.get('version') !== 1) throw new Error('Unsupported DeepSeek credentials version');
  credentials.set('version', 1);
  const refs = mapping(credentials, credentials.contents, 'refs');
  const providers = mapping(patch, plugin(patch, 'llm-pi-ai'), 'providers');
  const provider = managedProvider(patch, providers, entry);
  for (const field of ['displayName', 'api', 'baseURL', 'apiKeyEnv']) provider.set(field, entry[field]);
  const oldModels = provider.get('models', true);
  const models = patch.createNode([]);
  for (const model of entry.models) {
    const existing = YAML.isSeq(oldModels) && oldModels.items.find(node => YAML.isMap(node) && node.get('id') === model.id);
    const node = existing ? existing.clone() : patch.createNode({});
    for (const [key, value] of Object.entries(model)) node.set(key, value);
    models.add(node);
  }
  provider.set('models', models);
  // Earlier builds wrote upstream keys under a generated CODEXSWITCH_DSH_* ref.
  // Direct switches now share DEFAULT_API_KEY, so drop those stale credential
  // references (they are never the router's own token slot).
  for (const key of refs.items.map(pair => String(pair.key))) {
    if (/^CODEXSWITCH_DSH_[A-F0-9]{24}$/.test(key)) refs.delete(key);
  }
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey : config.api_key;
  if (config.clearCredentials || config.clear_credentials) refs.delete(entry.apiKeyEnv);
  else if (apiKey) refs.set(entry.apiKeyEnv, apiKey);
  const defaults = plugin(patch, 'agent-default-model');
  defaults.set('provider', entry.providerKey);
  defaults.set('model', entry.model);
  return { entry, patch: patch.toString(), credentials: credentials.toString() };
}
/** Chrome-launched native hosts inherit provenance, so macOS tags files they
 * write with com.apple.quarantine; that makes Gatekeeper refuse to open them
 * ("cannot verify ... does not contain malware"). Strip it after each write. */
function clearQuarantine(file) {
  if (process.platform !== 'darwin') return;
  try { fs.removexattrSync(file, 'com.apple.quarantine'); }
  catch { /* attribute absent or unsupported; nothing to clear */ }
}
function atomicWrite(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode });
    clearQuarantine(temporary);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, mode);
    clearQuarantine(file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function updateDeepSeekHarnessConfig(config = {}, action = 'updateDeepSeekHarnessConfig') {
  const paths = resolveDeepSeekHarnessPaths(config);
  const snapshots = [paths.patchFile, paths.credentialsFile].map(file => ({ file, exists: fs.existsSync(file), text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600 }));
  // Parse and validate BOTH inputs before writing either one.
  const next = render(config, snapshots[0].text, snapshots[1].text);
  try {
    atomicWrite(paths.patchFile, next.patch, snapshots[0].mode);
    atomicWrite(paths.credentialsFile, next.credentials, 0o600);
  } catch (error) {
    const errors = [];
    for (const snapshot of snapshots) {
      try { if (snapshot.exists) atomicWrite(snapshot.file, snapshot.text, snapshot.mode); else fs.rmSync(snapshot.file, { force: true }); }
      catch (restoreError) { errors.push(restoreError.message); }
    }
    throw new Error(`${error.message}${errors.length ? `; rollback failed: ${errors.join('; ')}` : ''}`);
  }
  return { success: true, data: { ...paths, patchPath: paths.patchFile, credentialsPath: paths.credentialsFile, providers: [{ id: next.entry.providerKey, api: next.entry.api, apiKeyEnv: next.entry.apiKeyEnv, models: next.entry.models.map(model => model.id) }], protocols: [next.entry.api], action } };
}
module.exports = { resolveDeepSeekHarnessPaths, updateDeepSeekHarnessConfig, render, protocol };
