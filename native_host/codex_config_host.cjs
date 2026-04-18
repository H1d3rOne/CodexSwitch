#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const CODEX_DIR = path.join(os.homedir(), '.codex');
const CONFIG_TOML = path.join(CODEX_DIR, 'config.toml');
const AUTH_JSON = path.join(CODEX_DIR, 'auth.json');

function readSync() {
  const lengthBuf = Buffer.alloc(4);
  const bytesRead = fs.readSync(0, lengthBuf, 0, 4, null);
  if (bytesRead < 4) return null;

  const length = lengthBuf.readUInt32LE(0);
  const messageBuf = Buffer.alloc(length);
  fs.readSync(0, messageBuf, 0, length, null);
  return JSON.parse(messageBuf.toString('utf8'));
}

function writeSync(message) {
  const encoded = Buffer.from(JSON.stringify(message), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(encoded.length, 0);
  fs.writeSync(1, length);
  fs.writeSync(1, encoded);
}

function escapeTomlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function detectEol(content) {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function toLines(content) {
  return content.length > 0 ? content.split(/\r?\n/) : [];
}

function fromLines(lines, eol) {
  return lines.join(eol).replace(new RegExp(`${eol}+$`), '') + eol;
}

function upsertTopLevelField(lines, field, value) {
  const fieldLine = `${field} = "${escapeTomlString(value)}"`;
  const firstSectionIndex = lines.findIndex(line => /^\s*\[/.test(line));
  const searchEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;

  for (let i = 0; i < searchEnd; i += 1) {
    if (new RegExp(`^\s*${field}\s*=`).test(lines[i])) {
      lines[i] = fieldLine;
      return;
    }
  }

  lines.splice(searchEnd, 0, fieldLine);
}

function formatProviderSectionHeader(name) {
  return /^[A-Za-z0-9_-]+$/.test(name)
    ? `[model_providers.${name}]`
    : `[model_providers."${escapeTomlString(name)}"]`;
}

function upsertProviderSection(lines, providerName, baseUrl) {
  const header = formatProviderSectionHeader(providerName);
  const start = lines.findIndex(line => line.trim() === header);
  const sectionLines = [
    `name = "${escapeTomlString(providerName)}"`,
    `base_url = "${escapeTomlString(baseUrl)}"`,
  ];

  if (start === -1) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
      lines.push('');
    }
    lines.push(header, ...sectionLines);
    return;
  }

  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) {
    end += 1;
  }

  const existingBody = lines.slice(start + 1, end);
  for (const [field, value] of [['name', providerName], ['base_url', baseUrl]]) {
    const replacement = `${field} = "${escapeTomlString(value)}"`;
    const idx = existingBody.findIndex(line => new RegExp(`^\s*${field}\s*=`).test(line));
    if (idx === -1) {
      existingBody.push(replacement);
    } else {
      existingBody[idx] = replacement;
    }
  }

  lines.splice(start, end - start, header, ...existingBody);
}

function updateConfigToml(config) {
  try {
    fs.mkdirSync(CODEX_DIR, { recursive: true });

    const content = fs.existsSync(CONFIG_TOML)
      ? fs.readFileSync(CONFIG_TOML, 'utf8')
      : '';

    const eol = detectEol(content);
    const lines = toLines(content);

    if (config.name) {
      upsertTopLevelField(lines, 'model_provider', config.name);
    }
    if (config.model) {
      upsertTopLevelField(lines, 'model', config.model);
    }
    if (config.name && config.baseUrl) {
      upsertProviderSection(lines, config.name, config.baseUrl);
    }

    fs.writeFileSync(CONFIG_TOML, fromLines(lines, eol), 'utf8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function updateAuthJson(apiKey) {
  try {
    let authData = {};

    if (fs.existsSync(AUTH_JSON)) {
      const content = fs.readFileSync(AUTH_JSON, 'utf8');
      authData = JSON.parse(content);
    }

    authData.OPENAI_API_KEY = apiKey;

    fs.mkdirSync(CODEX_DIR, { recursive: true });
    fs.writeFileSync(AUTH_JSON, JSON.stringify(authData, null, 2), 'utf8');

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

try {
  const message = readSync();

  if (message && message.action === 'updateConfig') {
    const config = message.config || {};

    const tomlResult = updateConfigToml(config);
    const authResult = config.apiKey ? updateAuthJson(config.apiKey) : { success: true };

    if (tomlResult.success && authResult.success) {
      writeSync({ success: true });
    } else {
      writeSync({ success: false, error: tomlResult.error || authResult.error });
    }
  } else if (message && message.action === 'ping') {
    writeSync({ success: true, pong: true });
  } else {
    writeSync({ success: false, error: 'Unknown action' });
  }
} catch (e) {
  writeSync({ success: false, error: e.message });
}
