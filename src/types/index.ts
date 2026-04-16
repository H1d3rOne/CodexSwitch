export interface TestStatus {
  lastTestTime: number
  isSuccess: boolean
  statusCode?: number
  errorMessage?: string
}

export interface Provider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
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
  }>
}

export interface TestResult {
  success: boolean
  statusCode?: number
  message: string
  error?: string
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

export interface Message {
  type: MessageType
  payload?: unknown
}

export interface MessageResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}
