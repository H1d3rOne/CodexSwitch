# Codex Switch

[English](./README_EN.md) | [简体中文](./README.md)

A Chrome extension for managing multiple OpenAI-compatible API providers, with one-click switching, connection testing, AI chat, and config sync to Codex CLI.

## Features

- **Provider Management** - Add, edit, delete multiple OpenAI-compatible API providers
- **One-Click Switch** - Quickly switch the active API provider
- **Connection Testing** - Test API connections, support batch testing
- **AI Chat** - Built-in chat interface for quick API response testing
- **Config Sync** - Sync config to `~/.codex/config.toml` and `~/.codex/auth.json` via Native Messaging
- **Import/Export** - Import and export provider configurations

## Installation

### 1. Build the Extension

```bash
# Clone the repository
git clone https://github.com/H1d3rOne/CodexSwitch.git
cd CodexSwitch

# Install dependencies
npm install

# Build
npm run build
```

The build output is in the `dist/` directory.

### 2. Install Extension in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** in the top right
3. Click **Load unpacked**
4. Select the `dist` directory
5. Note the extension ID (needed for Native Host installation)

### 3. Install Native Host (Optional, for Codex CLI sync)

Native Host syncs provider config to system Codex CLI config files.

#### macOS

```bash
cd native_host
chmod +x install.sh
./install.sh
```

Enter the extension ID when prompted.

#### Linux

```bash
cd native_host
chmod +x install.sh
./install.sh
```

Enter the extension ID when prompted.

#### Windows

Run PowerShell:

```powershell
cd native_host
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Enter the extension ID when prompted.

**Windows Requirements:**
- Node.js (in PATH)
- .NET Framework (for C# launcher compilation)

### 4. Restart Chrome

After installing Native Host, restart Chrome for changes to take effect.

## Usage

### Add Provider

1. Click the extension icon to open the side panel
2. Click **Add Provider** button
3. Fill in provider information:
   - **Name** - Provider display name
   - **Base URL** - API base URL (e.g., `https://api.openai.com/v1`)
   - **API Key** - API key
   - **Model** - Default model to use
   - **Models List** - Optional, add multiple available models
4. Click **Save & Test** to validate the config

### Switch Provider

Click on a provider card to set it as the active provider. Enable the **Sync** toggle to auto-sync to Codex CLI config.

### Test Connection

- **Single Test** - Click the test button on the right side of provider card
- **Batch Test** - Click **Test All** button at the top

### AI Chat

1. Click the chat icon in the top left to enter chat interface
2. Select provider and model
3. Enter message to start conversation
4. Supports multiple sessions

### Import/Export

- **Export** - Click **Export** button at the bottom to export all provider configs as JSON
- **Import** - Click **Import** button at the bottom to import provider configs from JSON

## Config Files

### Codex CLI Config (synced via Native Host)

Sync behavior:

- Keep the existing top-level `model_provider` unchanged
- Update the top-level `model`
- Update the current `model_provider` section's `name` and `base_url`
- Initialize `config.toml` automatically if it does not exist

**~/.codex/config.toml**
```toml
model_provider = "OpenAI"
model = "gpt-4"

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://api.openai.com"
```

**~/.codex/auth.json**
```json
{
  "OPENAI_API_KEY": "sk-..."
}
```

## Uninstall

### Uninstall Extension

1. Go to `chrome://extensions/`
2. Find Codex Switch extension
3. Click **Remove**

### Uninstall Native Host

**macOS / Linux**
```bash
cd native_host
./uninstall.sh
```

**Windows**
```powershell
cd native_host
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

## Troubleshooting

### Native Host Connection Failed

1. Confirm extension ID matches what was entered during installation
2. Confirm Node.js is installed and in PATH
3. Check if manifest file exists:
   - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/codex_config_host.json`
   - Linux: `~/.config/google-chrome/NativeMessagingHosts/codex_config_host.json`
   - Windows: Registry `HKCU\Software\Google\Chrome\NativeMessagingHosts\codex_config_host`
4. Restart Chrome browser

### API Test Failed

- Confirm Base URL format is correct (usually needs `/v1`)
- Confirm API Key is valid
- Check network connection and proxy settings

## Development

```bash
# Install dependencies
npm install

# Development mode
npm run dev

# Build
npm run build

# Run tests
npm test
```

## Tech Stack

- React 18
- TypeScript
- Vite
- Tailwind CSS
- Chrome Extension Manifest V3
- Chrome Native Messaging

## License

MIT
