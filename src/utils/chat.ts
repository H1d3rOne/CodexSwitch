import type { ChatSession, ChatMessage } from '../types'

const CHAT_SESSIONS_KEY = 'codex_switch_chat_sessions'
const ACTIVE_SESSION_KEY = 'codex_switch_active_session'
const MAX_SESSIONS = 20

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9)
}

function generateTitle(messages: ChatMessage[]): string {
  if (messages.length === 0) return 'New Chat'
  const firstMsg = messages[0].content
  return firstMsg.length > 30 ? firstMsg.slice(0, 30) + '...' : firstMsg
}

export async function getChatSessions(): Promise<ChatSession[]> {
  const result = await chrome.storage.local.get(CHAT_SESSIONS_KEY)
  return result[CHAT_SESSIONS_KEY] || []
}

export async function getActiveSessionId(): Promise<string | null> {
  const result = await chrome.storage.local.get(ACTIVE_SESSION_KEY)
  return result[ACTIVE_SESSION_KEY] || null
}

export async function setActiveSessionId(id: string): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_SESSION_KEY]: id })
}

export async function saveChatSession(
  id: string | null,
  providerId: string,
  model: string,
  messages: ChatMessage[]
): Promise<ChatSession> {
  const sessions = await getChatSessions()
  const now = Date.now()
  
  let session: ChatSession
  if (id) {
    const idx = sessions.findIndex(s => s.id === id)
    if (idx >= 0) {
      session = {
        ...sessions[idx],
        providerId,
        model,
        messages,
        title: generateTitle(messages),
        updatedAt: now,
      }
      sessions[idx] = session
    } else {
      session = {
        id: generateId(),
        title: generateTitle(messages),
        providerId,
        model,
        messages,
        createdAt: now,
        updatedAt: now,
      }
      sessions.unshift(session)
    }
  } else {
    session = {
      id: generateId(),
      title: generateTitle(messages),
      providerId,
      model,
      messages,
      createdAt: now,
      updatedAt: now,
    }
    sessions.unshift(session)
  }

  const trimmed = sessions.slice(0, MAX_SESSIONS)
  await chrome.storage.local.set({ [CHAT_SESSIONS_KEY]: trimmed })
  await setActiveSessionId(session.id)
  return session
}

export async function deleteChatSession(id: string): Promise<void> {
  const sessions = await getChatSessions()
  const filtered = sessions.filter(s => s.id !== id)
  await chrome.storage.local.set({ [CHAT_SESSIONS_KEY]: filtered })
  
  const activeId = await getActiveSessionId()
  if (activeId === id) {
    const newActive = filtered[0]?.id || null
    if (newActive) {
      await setActiveSessionId(newActive)
    } else {
      await chrome.storage.local.remove(ACTIVE_SESSION_KEY)
    }
  }
}

export async function createNewSession(): Promise<ChatSession> {
  const now = Date.now()
  const session: ChatSession = {
    id: generateId(),
    title: 'New Chat',
    providerId: '',
    model: '',
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
  
  const sessions = await getChatSessions()
  sessions.unshift(session)
  const trimmed = sessions.slice(0, MAX_SESSIONS)
  await chrome.storage.local.set({ [CHAT_SESSIONS_KEY]: trimmed })
  await setActiveSessionId(session.id)
  return session
}
