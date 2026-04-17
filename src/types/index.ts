export interface TestStatus {
  lastTestTime: number
  isSuccess: boolean
  statusCode?: number
  errorMessage?: string
  responseBody?: string
}

export interface Provider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  models: string[]
  isActive: boolean
  testStatus?: TestStatus
  createdAt: number
  updatedAt: number
}

export interface StorageData {
  providers: Provider[]
  activeProviderId: string | null
}

export interface ExportData {
  version: string
  exportedAt: string
  providers: Array<{
    name: string
    baseUrl: string
    apiKey: string
    model: string
    models: string[]
  }>
}

export interface TestResult {
  success: boolean
  statusCode?: number
  message: string
  error?: string
  responseBody?: string
  correctedBaseUrl?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ChatSession {
  id: string
  title: string
  providerId: string
  model: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

export type MessageType =
  | 'GET_PROVIDERS'
  | 'ADD_PROVIDER'
  | 'UPDATE_PROVIDER'
  | 'DELETE_PROVIDER'
  | 'SET_ACTIVE_PROVIDER'
  | 'TEST_PROVIDER'
  | 'EXPORT_PROVIDERS'
  | 'IMPORT_PROVIDERS'
  | 'GET_CHAT_SESSIONS'
  | 'SAVE_CHAT_SESSION'
  | 'DELETE_CHAT_SESSION'
  | 'SET_ACTIVE_SESSION'

export interface Message {
  type: MessageType
  payload?: unknown
}

export interface MessageResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}
