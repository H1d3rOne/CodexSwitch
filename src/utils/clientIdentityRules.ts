import type { ProviderFormat } from '../types'
import {
  type ClientIdentity,
  type ClientIdentitySettings,
  getClientIdentitySettings,
} from './clientIdentity'

/**
 * `fetch()` in an extension cannot set `User-Agent` (it is a forbidden header),
 * so the identity is applied by declarativeNetRequest instead. Rules are keyed
 * per upstream host and rebuilt whenever providers or the identity change.
 */
const RULE_ID_BASE = 7100
const RULE_ID_LIMIT = 200

export interface IdentityRuleHost {
  host: string
  format?: ProviderFormat
  /** Path prefix of the provider's baseUrl, e.g. `/deepseek/v1`. */
  pathPrefix?: string
}

export function identityHost(baseUrl: string): string | null {
  return identityTarget(baseUrl)?.host ?? null
}

/**
 * Splits a provider baseUrl into host + path prefix. The path matters because
 * several providers commonly share one relay host (e.g. `/anthropic/v1` and
 * `/deepseek/v1`); keying rules by host alone would force them to share a
 * single identity.
 */
export function identityTarget(baseUrl: string): { host: string; pathPrefix: string } | null {
  try {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return { host: url.hostname.toLowerCase(), pathPrefix: url.pathname.replace(/\/+$/, '') }
  } catch {
    return null
  }
}

/**
 * One rule target per distinct (host, path prefix) pair. Two providers with the
 * exact same baseUrl cannot be told apart by request URL, so only the first is
 * kept; providers on different paths stay fully independent.
 */
export function collectIdentityHosts(providers: Array<{ baseUrl?: string; format?: ProviderFormat }>): IdentityRuleHost[] {
  const seen = new Set<string>()
  const hosts: IdentityRuleHost[] = []
  for (const provider of providers) {
    if (!provider.baseUrl) continue
    const target = identityTarget(provider.baseUrl)
    if (!target) continue
    const key = `${target.host}${target.pathPrefix}`
    if (seen.has(key)) continue
    seen.add(key)
    hosts.push({ host: target.host, pathPrefix: target.pathPrefix, format: provider.format })
  }
  return hosts
}

/** Identity is now applied per dispatched request, never per relay domain.
 * Retain this API to remove previously installed broad dynamic rules. */
export function buildClientIdentityRules(
  _identity: ClientIdentity | ClientIdentitySettings,
  _hosts: IdentityRuleHost[],
): chrome.declarativeNetRequest.Rule[] {
  return []
}

let ruleMutationQueue: Promise<unknown> = Promise.resolve()

function replaceRules(rules: chrome.declarativeNetRequest.Rule[]): Promise<boolean> {
  // The read/remove/add sequence must be one mutation. Concurrent refreshes
  // otherwise reuse a stale ID inventory and Chrome rejects duplicate IDs.
  const operation = ruleMutationQueue.then(() => replaceRulesNow(rules))
  ruleMutationQueue = operation.catch(() => undefined)
  return operation
}

async function replaceRulesNow(rules: chrome.declarativeNetRequest.Rule[]): Promise<boolean> {
  const dnr = globalThis.chrome?.declarativeNetRequest
  if (!dnr?.updateDynamicRules || !dnr.getDynamicRules) return false
  const existing = await dnr.getDynamicRules()
  const managed = existing.filter(rule => rule.id >= RULE_ID_BASE && rule.id < RULE_ID_BASE + RULE_ID_LIMIT)
  await dnr.updateDynamicRules({
    removeRuleIds: managed.map(rule => rule.id),
    addRules: rules,
  })
  return true
}

/**
 * Rebuilds the header-rewrite rules for the current identity and provider hosts.
 * Safe to call on install, on identity change and after any provider mutation.
 */
export async function syncClientIdentityRules(
  providers: Array<{ baseUrl?: string; format?: ProviderFormat }>,
  identity?: ClientIdentity | ClientIdentitySettings,
): Promise<{ ok: boolean; ruleCount: number; error?: string }> {
  const resolvedIdentity = identity || await getClientIdentitySettings()
  const rules = buildClientIdentityRules(resolvedIdentity, collectIdentityHosts(providers))
  try {
    const applied = await replaceRules(rules)
    return { ok: true, ruleCount: applied ? rules.length : 0 }
  } catch (error) {
    console.warn('Could not apply client identity rules', error)
    return { ok: false, ruleCount: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function clearClientIdentityRules(): Promise<void> {
  try {
    await replaceRules([])
  } catch (error) {
    console.warn('Could not clear client identity rules', error)
  }
}
