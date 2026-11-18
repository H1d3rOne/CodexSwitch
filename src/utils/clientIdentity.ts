import type { ProviderFormat } from '../types'

/**
 * Per-client fingerprint presets.
 *
 * The upstream relays we target gate on "is this an approved coding client?".
 * Each preset mimics one approved client so every request carries a transport
 * identity the relay accepts, regardless of which provider format is spoken.
 *
 * Three consumers share this module:
 *  - `api.ts` applies the identity to direct `fetch()` calls.
 *  - Chrome `declarativeNetRequest` rules (`clientIdentityRules.ts`) rewrite the
 *    `User-Agent` header for direct traffic, because browser `fetch()` may not
 *    set forbidden headers itself.
 *  - The native Router (Node) applies the same headers when it forwards
 *    converted-format traffic upstream (`buildRouterIdentityMap`).
 */

export type ClientPreset = 'auto' | 'off' | 'custom' | 'codex' | 'claude-code' | 'opencode' | 'deepseek-harness'

export interface ClientIdentity {
  preset: ClientPreset
  /** Preset protocol version (e.g. the CLI build number in the User-Agent). */
  version?: string
  /** Overrides the preset User-Agent entirely when set (custom preset). */
  userAgent?: string
  /** Extra headers merged into the resolved identity. */
  extraHeaders?: Record<string, string>
}

export const DEFAULT_CLIENT_IDENTITY: ClientIdentity = { preset: 'auto' }

export const CLIENT_IDENTITY_STORAGE_KEY = 'client_identity'

/**
 * One identity per wire format plus the global fallback. `formatIdentities`
 * wins for its format; `default` covers everything else (and every host whose
 * provider format is unknown).
 */
export interface ClientIdentitySettings {
  default: ClientIdentity
  formatIdentities: Partial<Record<ProviderFormat, ClientIdentity>>
}

export const DEFAULT_CLIENT_IDENTITY_SETTINGS: ClientIdentitySettings = {
  default: { ...DEFAULT_CLIENT_IDENTITY },
  formatIdentities: {},
}

/**
 * Router-only client disguise. Unlike `ClientIdentitySettings` (which is keyed
 * by the *target provider* format), this is keyed by the *entry client* — the
 * namespace the client uses to reach the Router:
 *   openai = Codex CLI, anthropic = Claude Code, deepseek = DeepSeek Harness.
 * Each entry picks which client the forwarded request should impersonate. It
 * applies only when the Router is enabled, after format conversion.
 */
export type ClientDisguiseSettings = Partial<Record<ProviderFormat, ClientIdentity>>

export const CLIENT_DISGUISE_STORAGE_KEY = 'client_disguise'

export function normalizeClientDisguiseSettings(raw: unknown): ClientDisguiseSettings {
  const result: ClientDisguiseSettings = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result
  for (const format of ['openai', 'anthropic', 'deepseek'] as ProviderFormat[]) {
    const entry = (raw as Record<string, unknown>)[format]
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) result[format] = normalizeClientIdentity(entry)
  }
  return result
}

export async function getClientDisguiseSettings(): Promise<ClientDisguiseSettings> {
  try {
    const stored = await chrome.storage.local.get(CLIENT_DISGUISE_STORAGE_KEY)
    return normalizeClientDisguiseSettings(stored[CLIENT_DISGUISE_STORAGE_KEY])
  } catch {
    return {}
  }
}

export async function saveClientDisguiseSettings(settings: ClientDisguiseSettings): Promise<ClientDisguiseSettings> {
  const normalized = normalizeClientDisguiseSettings(settings)
  await chrome.storage.local.set({ [CLIENT_DISGUISE_STORAGE_KEY]: normalized })
  return normalized
}

export function normalizeClientIdentitySettings(raw: unknown): ClientIdentitySettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CLIENT_IDENTITY_SETTINGS, default: { ...DEFAULT_CLIENT_IDENTITY_SETTINGS.default }, formatIdentities: {} }
  const value = raw as Partial<ClientIdentitySettings>
  const formatIdentities: Partial<Record<ProviderFormat, ClientIdentity>> = {}
  if (value.formatIdentities && typeof value.formatIdentities === 'object') {
    for (const format of ['openai', 'anthropic', 'deepseek'] as ProviderFormat[]) {
      const entry = (value.formatIdentities as Record<string, unknown>)[format]
      if (entry && typeof entry === 'object') formatIdentities[format] = normalizeClientIdentity(entry)
    }
  }
  return {
    default: value.default ? normalizeClientIdentity(value.default) : { ...DEFAULT_CLIENT_IDENTITY },
    formatIdentities,
  }
}

/** The identity that applies to a given wire format. */
export function identityForFormat(settings: ClientIdentitySettings, format?: ProviderFormat): ClientIdentity {
  if (format && settings.formatIdentities[format]) return settings.formatIdentities[format]!
  return settings.default
}

export async function getClientIdentitySettings(): Promise<ClientIdentitySettings> {
  try {
    const stored = await chrome.storage.local.get(CLIENT_IDENTITY_STORAGE_KEY)
    return normalizeClientIdentitySettings(stored[CLIENT_IDENTITY_STORAGE_KEY])
  } catch {
    return { default: { ...DEFAULT_CLIENT_IDENTITY }, formatIdentities: {} }
  }
}

export async function saveClientIdentitySettings(settings: ClientIdentitySettings): Promise<ClientIdentitySettings> {
  const normalized = normalizeClientIdentitySettings(settings)
  await chrome.storage.local.set({ [CLIENT_IDENTITY_STORAGE_KEY]: normalized })
  return normalized
}

export interface ClientPresetInfo {
  label: string
  defaultVersion: string
}

/** Display metadata for the per-format tabs in the settings drawer. */
export const PROVIDER_FORMAT_META: Record<ProviderFormat, { label: string; accent: string }> = {
  openai: { label: 'OpenAI', accent: 'text-blue-500' },
  anthropic: { label: 'Anthropic', accent: 'text-orange-500' },
  deepseek: { label: 'DeepSeek', accent: 'text-indigo-500' },
}

/** Presets exposed in the settings UI; auto/off/custom are handled separately. */
export const CLIENT_PRESETS: Record<Exclude<ClientPreset, 'auto' | 'off' | 'custom'>, ClientPresetInfo> = {
  'codex': { label: 'Codex CLI', defaultVersion: '0.61.0' },
  'claude-code': { label: 'Claude Code', defaultVersion: '2.0.76' },
  'opencode': { label: 'OpenCode', defaultVersion: '0.16.0' },
  'deepseek-harness': { label: 'DeepSeek Harness', defaultVersion: '0.61.0' },
}

/** Auto maps each wire format to the client that natively speaks it. */
const AUTO_PRESET_BY_FORMAT: Record<ProviderFormat, ClientPreset> = {
  openai: 'codex',
  anthropic: 'claude-code',
  deepseek: 'deepseek-harness',
}

const PRESETS: ClientPreset[] = ['auto', 'off', 'custom', ...Object.keys(CLIENT_PRESETS)] as ClientPreset[]

export function resolvePreset(identity: ClientIdentity, format?: ProviderFormat): ClientPreset {
  if (identity.preset !== 'auto') return identity.preset
  if (!format) return DEFAULT_CLIENT_IDENTITY.preset
  return AUTO_PRESET_BY_FORMAT[format] || DEFAULT_CLIENT_IDENTITY.preset
}

export function normalizeClientIdentity(raw: unknown): ClientIdentity {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CLIENT_IDENTITY }
  const value = raw as Partial<ClientIdentity>
  const preset = PRESETS.includes(value.preset as ClientPreset) ? value.preset as ClientPreset : DEFAULT_CLIENT_IDENTITY.preset
  const extraHeaders = value.extraHeaders && typeof value.extraHeaders === 'object' && !Array.isArray(value.extraHeaders)
    ? Object.fromEntries(
        Object.entries(value.extraHeaders)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    : undefined
  return {
    preset,
    ...(typeof value.version === 'string' && value.version ? { version: value.version } : {}),
    ...(typeof value.userAgent === 'string' && value.userAgent ? { userAgent: value.userAgent } : {}),
    ...(extraHeaders ? { extraHeaders } : {}),
  }
}

export async function getClientIdentity(): Promise<ClientIdentity> {
  return (await getClientIdentitySettings()).default
}

export async function saveClientIdentity(identity: ClientIdentity): Promise<ClientIdentity> {
  const current = await getClientIdentitySettings()
  const normalized = normalizeClientIdentity(identity)
  await chrome.storage.local.set({ [CLIENT_IDENTITY_STORAGE_KEY]: { ...current, default: normalized } })
  return normalized
}

export interface IdentityContext {
  protocol?: 'chat' | 'responses' | 'messages'
  format?: ProviderFormat
  /** Stable per-request identifier; Codex sends one on every call. */
  sessionId?: string
}

export interface ResolvedIdentity {
  userAgent?: string
  headers: Record<string, string>
  stripSdkHeaders: boolean
}

function presetVersion(identity: ClientIdentity, preset: ClientPreset): string {
  return identity.version || CLIENT_PRESETS[preset as keyof typeof CLIENT_PRESETS]?.defaultVersion || ''
}

function codexIdentity(identity: ClientIdentity, context: IdentityContext): ResolvedIdentity {
  const version = presetVersion(identity, 'codex')
  const headers: Record<string, string> = {
    'originator': 'codex_cli_rs',
    'version': version,
    'x-client-name': 'codex_cli_rs',
    'openai-beta': 'responses=experimental',
  }
  if (context.protocol === 'messages') {
    // Messages traffic still needs the Anthropic wire header to be accepted at all.
    headers['anthropic-version'] = '2023-06-01'
  }
  if (context.sessionId) headers['session_id'] = context.sessionId
  return { userAgent: identity.userAgent || `codex_cli_rs/${version}`, headers, stripSdkHeaders: true }
}

function claudeCodeIdentity(identity: ClientIdentity, context: IdentityContext): ResolvedIdentity {
  const version = presetVersion(identity, 'claude-code')
  const headers: Record<string, string> = {
    'x-app': 'cli',
    'anthropic-beta': `claude-code-${version}`,
    'anthropic-version': '2023-06-01',
  }
  if (context.sessionId) headers['x-session-id'] = context.sessionId
  return { userAgent: identity.userAgent || `claude-cli/${version}`, headers, stripSdkHeaders: true }
}

function opencodeIdentity(identity: ClientIdentity, context: IdentityContext): ResolvedIdentity {
  const version = presetVersion(identity, 'opencode')
  const headers: Record<string, string> = {}
  if (context.protocol === 'messages') headers['anthropic-version'] = '2023-06-01'
  if (context.sessionId) headers['x-session-id'] = context.sessionId
  return { userAgent: identity.userAgent || `opencode/${version}`, headers, stripSdkHeaders: true }
}

function deepseekHarnessIdentity(identity: ClientIdentity, context: IdentityContext): ResolvedIdentity {
  const version = presetVersion(identity, 'deepseek-harness')
  const headers: Record<string, string> = {
    'x-client-name': 'deepseek-harness',
  }
  if (context.protocol === 'messages') headers['anthropic-version'] = '2023-06-01'
  return { userAgent: identity.userAgent || `deepseek-harness/${version}`, headers, stripSdkHeaders: true }
}

function customIdentity(identity: ClientIdentity, context: IdentityContext): ResolvedIdentity {
  const headers: Record<string, string> = { ...(identity.extraHeaders || {}) }
  if (context.protocol === 'messages' && !headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'
  return { userAgent: identity.userAgent || undefined, headers, stripSdkHeaders: false }
}

export function resolveClientIdentity(identity: ClientIdentity = { ...DEFAULT_CLIENT_IDENTITY }, context: IdentityContext = {}): ResolvedIdentity {
  const preset = resolvePreset(identity, context.format)
  switch (preset) {
    case 'off':
      return { headers: {}, stripSdkHeaders: false }
    case 'custom':
      return customIdentity(identity, context)
    case 'claude-code':
      return claudeCodeIdentity(identity, context)
    case 'opencode':
      return opencodeIdentity(identity, context)
    case 'deepseek-harness':
      return deepseekHarnessIdentity(identity, context)
    case 'codex':
    default:
      return codexIdentity(identity, context)
  }
}

const SDK_HEADER_PREFIXES = ['x-stainless-', 'x-sdk-', 'x-browser-', 'sec-ch-ua']

/** Headers the browser SDKs add that relays may use to fingerprint non-CLI clients. */
export const SDK_HEADERS = [
  'x-stainless-arch',
  'x-stainless-helper-method',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-timeout',
]

export function stripSdkFingerprint(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (SDK_HEADER_PREFIXES.some(prefix => key.toLowerCase().startsWith(prefix))) continue
    result[key] = value
  }
  return result
}

/** Credential / protocol headers that must survive an identity swap. */
const PROTECTED_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'content-type',
  'content-length',
  'accept-encoding',
  'host',
  'connection',
  'anthropic-version',
  'anthropic-beta',
])

/**
 * Accepts either a single identity or full per-format settings and picks the
 * one that governs the requested wire format.
 */
function resolveIdentityArg(
  identity: ClientIdentity | ClientIdentitySettings | undefined,
  format?: ProviderFormat,
): ClientIdentity {
  if (!identity) return { ...DEFAULT_CLIENT_IDENTITY }
  if ('preset' in identity) return identity
  return identityForFormat(identity, format)
}

/**
 * Applies the client identity to an existing header map without touching the
 * credential, the wire protocol, or transport-managed headers.
 */
export function applyClientIdentity(
  headers: Record<string, string>,
  identity?: ClientIdentity | ClientIdentitySettings,
  context: IdentityContext = {},
): Record<string, string> {
  const resolvedIdentity = resolveIdentityArg(identity, context.format)
  const resolved = resolveClientIdentity(resolvedIdentity, context)
  if (!resolved.userAgent && Object.keys(resolved.headers).length === 0 && !resolved.stripSdkHeaders) return headers
  const base = stripSdkFingerprint(headers)
  const protectedValues: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (PROTECTED_HEADERS.has(key.toLowerCase())) protectedValues[key] = value
  }
  const merged: Record<string, string> = { ...base, ...resolved.headers }
  Object.assign(merged, protectedValues)
  if (resolved.userAgent) merged['User-Agent'] = resolved.userAgent
  return merged
}

/** Headers the client must attach for the given upstream format/protocol. */
export function identityHeadersForFormat(
  identity: ClientIdentity | ClientIdentitySettings,
  format: ProviderFormat,
  protocol: 'chat' | 'responses' | 'messages',
  sessionId?: string,
): Record<string, string> {
  const resolved = resolveClientIdentity(resolveIdentityArg(identity, format), { format, protocol, sessionId })
  return resolved.userAgent
    ? { ...resolved.headers, 'User-Agent': resolved.userAgent }
    : resolved.headers
}

export interface RouterClientIdentity {
  userAgent?: string
  headers: Record<string, string>
  messagesHeaders: Record<string, string>
  stripSdkHeaders: boolean
}

const ANTHROPIC_PREFIX = 'anthropic-'

function splitProtocolHeaders(headers: Record<string, string>): { base: Record<string, string>; anthropic: Record<string, string> } {
  const base: Record<string, string> = {}
  const anthropic: Record<string, string> = {}
  for (const [header, value] of Object.entries(headers)) {
    if (header.toLowerCase().startsWith(ANTHROPIC_PREFIX)) anthropic[header] = value
    else base[header] = value
  }
  return { base, anthropic }
}

/**
 * Per-format payload handed to the native Router. Built here so the Node side
 * holds no preset table of its own.
 */
export function buildRouterIdentityMap(identity: ClientIdentity | ClientIdentitySettings = { ...DEFAULT_CLIENT_IDENTITY }): Partial<Record<ProviderFormat, RouterClientIdentity>> {
  const map: Partial<Record<ProviderFormat, RouterClientIdentity>> = {}
  for (const format of ['openai', 'anthropic', 'deepseek'] as const) {
    const formatIdentity = resolveIdentityArg(identity, format)
    const chat = resolveClientIdentity(formatIdentity, { format, protocol: 'chat' })
    const messages = resolveClientIdentity(formatIdentity, { format, protocol: 'messages' })
    const chatSplit = splitProtocolHeaders(chat.headers)
    const messagesSplit = splitProtocolHeaders(messages.headers)
    map[format] = {
      userAgent: chat.userAgent,
      headers: chatSplit.base,
      messagesHeaders: { ...chatSplit.anthropic, ...messagesSplit.anthropic },
      stripSdkHeaders: chat.stripSdkHeaders,
    }
  }
  return map
}

/**
 * Builds the Router-side disguise map, keyed by ENTRY client namespace
 * (openai/anthropic/deepseek). Only entries with an explicit non-off preset are
 * included; absent entries mean "do not disguise that client". The Router
 * applies the matching entry after format conversion, replacing the identity
 * chosen by the target-provider format.
 */
export function buildRouterDisguiseMap(settings: ClientDisguiseSettings = {}): Partial<Record<ProviderFormat, RouterClientIdentity>> {
  const map: Partial<Record<ProviderFormat, RouterClientIdentity>> = {}
  for (const format of ['openai', 'anthropic', 'deepseek'] as const) {
    const identity = settings[format]
    if (!identity || identity.preset === 'off') continue
    const chat = resolveClientIdentity(identity, { format, protocol: 'chat' })
    const messages = resolveClientIdentity(identity, { format, protocol: 'messages' })
    const chatSplit = splitProtocolHeaders(chat.headers)
    const messagesSplit = splitProtocolHeaders(messages.headers)
    map[format] = {
      userAgent: chat.userAgent,
      headers: chatSplit.base,
      messagesHeaders: { ...chatSplit.anthropic, ...messagesSplit.anthropic },
      stripSdkHeaders: chat.stripSdkHeaders,
    }
  }
  return map
}
