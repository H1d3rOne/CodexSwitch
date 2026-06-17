export interface TestStatus {
  lastTestTime: number
  isSuccess: boolean
  statusCode?: number
  errorMessage?: string
  responseBody?: string
}

export type ApiType = 'chat' | 'responses' | 'both'

export type ProviderFormat = 'openai' | 'anthropic'

export interface ModelEntry {
  name: string
  apiType: ApiType
  format?: ProviderFormat
}

export interface Provider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  groupApiKeys: Record<string, string>
  groupModels: Record<string, ModelEntry[]>
  activeGroup: string
  model: string
  models: ModelEntry[]
  formatModels?: Partial<Record<ProviderFormat, ModelEntry[]>>
  formatGroupModels?: Partial<Record<ProviderFormat, Record<string, ModelEntry[]>>>
  apiType: ApiType
  format: ProviderFormat
  isActive: boolean
  balance?: string
  testStatus?: TestStatus
  createdAt: number
  updatedAt: number
}

export interface CheckinTimeRange {
  startHour: number
  endHour: number
  scheduledMinute?: number
}

export type SiteType =
  | 'one-api'
  | 'new-api'
  | 'bohe'
  | 'anyrouter'
  | 'Veloera'
  | 'one-hub'
  | 'done-hub'
  | 'VoAPI'
  | 'Super-API'
  | 'Rix-Api'
  | 'neo-Api'
  | 'wong-gongyi'
  | 'sub2api'
  | 'octopus'
  | 'axonhub'
  | 'claude-code-hub'

export const SITE_TYPE_OPTIONS: { value: SiteType; label: string }[] = [
  { value: 'new-api', label: 'New API' },
  { value: 'bohe', label: '薄荷' },
  { value: 'one-api', label: 'One API' },
  { value: 'Veloera', label: 'Veloera' },
  { value: 'one-hub', label: 'One Hub' },
  { value: 'done-hub', label: 'Done Hub' },
  { value: 'VoAPI', label: 'VoAPI' },
  { value: 'Super-API', label: 'Super API' },
  { value: 'Rix-Api', label: 'Rix API' },
  { value: 'neo-Api', label: 'Neo API' },
  { value: 'wong-gongyi', label: 'Wong Gongyi' },
  { value: 'sub2api', label: 'Sub2API' },
  { value: 'octopus', label: 'Octopus' },
  { value: 'axonhub', label: 'AxonHub' },
  { value: 'claude-code-hub', label: 'Claude Code Hub' },
  { value: 'anyrouter', label: 'AnyRouter' },
]

export type SiteAuthType = 'accessToken' | 'cookie'

export type BalanceUnit = 'usd' | 'cny' | 'custom'

export type CookieStatus = 'valid' | 'invalid' | 'unknown'

export interface Site {
  id: string
  name: string
  url: string
  accessToken?: string
  cookie?: string
  token?: string
  userId?: string
  authType?: SiteAuthType
  siteType?: SiteType
  balanceUnit?: BalanceUnit
  balanceCustomUnit?: string
  providerId?: string
  autoCheckin?: boolean
  checkinTimeRange?: CheckinTimeRange
  balance?: string
  testStatus?: TestStatus
  checkinStatus?: TestStatus
  checkinDate?: string
  checkinFinal?: boolean
  checkinRetryCount?: number
  nextCheckinRetryAt?: number
  verificationTabOpenedDate?: string
  cookieStatus?: CookieStatus
  autoRefreshCookie?: boolean
  createdAt: number
  updatedAt: number
}

export interface StorageData {
  providers: Provider[]
  activeProviderId: string | null
  sites: Site[]
}

export interface ExportData {
  version: string
  exportedAt: string
  providers: Array<{
    name: string
    baseUrl: string
    apiKey: string
    groupApiKeys: Record<string, string>
    groupModels: Record<string, ModelEntry[]>
    activeGroup: string
    model: string
    models: ModelEntry[]
    formatModels?: Partial<Record<ProviderFormat, ModelEntry[]>>
    formatGroupModels?: Partial<Record<ProviderFormat, Record<string, ModelEntry[]>>>
    apiType: ApiType
    format: ProviderFormat
  }>
}

export interface EndpointDetail {
  label: string
  success: boolean
  statusCode: number
  error?: string
  responseBody?: string
}

export interface TestResult {
  success: boolean
  statusCode?: number
  message: string
  error?: string
  responseBody?: string
  correctedBaseUrl?: string
  endpoints?: EndpointDetail[]
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
  | 'UPDATE_TEST_STATUS'
  | 'EXPORT_PROVIDERS'
  | 'IMPORT_PROVIDERS'
  | 'GET_CHAT_SESSIONS'
  | 'SAVE_CHAT_SESSION'
  | 'DELETE_CHAT_SESSION'
  | 'SET_ACTIVE_SESSION'
  | 'GET_SITES'
  | 'ADD_SITE'
  | 'UPDATE_SITE'
  | 'DELETE_SITE'
  | 'TEST_SITE'
  | 'CHECKIN_SITE'
  | 'FETCH_SITE_MODELS'
  | 'CREATE_SITE_TOKEN'
  | 'FETCH_SITE_BALANCE'
  | 'FETCH_PROVIDER_MODELS'
  | 'FETCH_SITE_USER_ID'
  | 'REFRESH_ALL_BALANCES'
  | 'REORDER_PROVIDERS'
  | 'REORDER_SITES'
  | 'FETCH_BROWSER_COOKIES'
  | 'VALIDATE_SITE_COOKIE'
  | 'PERFORM_PENDING_CHECKIN'
  | 'FETCH_SITE_TOKEN_INFO'
  | 'FETCH_SITE_TOKEN_KEY'
  | 'CHECKIN_ANYROUTER'
  | 'SEND_WEBHOOK'
  | 'FETCH_SYSTEM_ACCESS_TOKEN'

export interface Message {
  type: MessageType
  payload?: unknown
}

export interface MessageResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}
