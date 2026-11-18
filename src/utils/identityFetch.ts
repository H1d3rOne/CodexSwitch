import type { ProviderFormat } from '../types'
import { clearClientIdentityRules } from './clientIdentityRules'
import { applyClientIdentity, getClientIdentitySettings } from './clientIdentity'

// Serialize request dispatch, not response-body consumption. Chrome controls UA
// in fetch, so hold an exact-URL rule until response headers arrive. A second
// request to the same endpoint must never replace the first request's identity.
let dispatchQueue: Promise<unknown> = Promise.resolve()
const REQUEST_RULE_ID = 7400

export function identityFetch(url: string, init: RequestInit, format: ProviderFormat, protocol: 'chat' | 'responses' | 'messages'): Promise<Response> {
  const operation = dispatchQueue.then(async () => {
    if (init.signal?.aborted) throw new DOMException('Request aborted', 'AbortError')
    await clearClientIdentityRules()
    const settings = await getClientIdentitySettings()
    const original = init.headers instanceof Headers || Array.isArray(init.headers)
      ? Object.fromEntries(new Headers(init.headers).entries())
      : { ...(init.headers || {}) }
    const headers = applyClientIdentity(original, settings, { format, protocol })
    const dnr = globalThis.chrome?.declarativeNetRequest
    const extensionId = globalThis.chrome?.runtime?.id
    const ua = headers['User-Agent']
    const canRewrite = typeof dnr?.updateSessionRules === 'function' && !!extensionId
    if (canRewrite) {
      await dnr.updateSessionRules({
        removeRuleIds: [REQUEST_RULE_ID],
        addRules: ua ? [{
          id: REQUEST_RULE_ID,
          priority: 100,
          action: {
            type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
            requestHeaders: [{ header: 'user-agent', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: ua }],
          },
          condition: {
            regexFilter: `^${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
            initiatorDomains: [extensionId!],
            resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType],
          },
        }] : [],
      })
    }
    try {
      return await fetch(url, { ...init, headers })
    } finally {
      if (canRewrite) await dnr.updateSessionRules({ removeRuleIds: [REQUEST_RULE_ID] })
    }
  })
  dispatchQueue = operation.catch(() => undefined)
  return operation
}
