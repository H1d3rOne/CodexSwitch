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

function replaceFieldValue(content, field, value) {
  const escapedValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const pattern = new RegExp(`^(\\s*${field}\\s*=\\s*).*`, 'gm');
  return content.replace(pattern, `$1"${escapedValue}"`);
}

function updateConfigToml(config) {
  try {
    if (!fs.existsSync(CONFIG_TOML)) {
      return { success: false, error: 'config.toml not found' };
    }
    
    let content = fs.readFileSync(CONFIG_TOML, 'utf8');
    
    if (config.name) {
      content = replaceFieldValue(content, 'name', config.name);
    }
    if (config.baseUrl) {
      content = replaceFieldValue(content, 'base_url', config.baseUrl);
    }
    if (config.model) {
      content = replaceFieldValue(content, 'model', config.model);
    }
    
    fs.writeFileSync(CONFIG_TOML, content, 'utf8');
    
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
