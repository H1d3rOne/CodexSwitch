import type { Site, TestResult } from '../types'

export const CHECKIN_RETRY_DELAY_MS = 10 * 60 * 1000

interface CheckinAttemptUpdateOptions {
  site: Site
  result: TestResult
  today: string
  nowMs: number
  isRetry: boolean
}

export interface CheckinAttemptUpdate {
  updates: Partial<Site>
  shouldOpenVerificationTab: boolean
}

interface VerificationBlockedPayload {
  statusCode?: number
  message?: string
  data?: unknown
  responseBody?: string
}

const VERIFICATION_BLOCK_PATTERNS = [
  'cf-turnstile',
  'turnstile',
  'cloudflare',
  'cdn-cgi/challenge-platform',
  '__cf_chl_',
  'cf-chl-',
  'cf-ray',
  'just a moment',
  'checking your browser',
  'verify you are human',
  'please verify you are human',
  'human verification',
  'managed challenge',
  'hcaptcha',
  'g-recaptcha',
  'recaptcha',
  'geetest',
  '验证码',
  '人机验证',
  '安全验证',
  '请先验证',
  '请先完成验证',
  '完成验证',
]

export function isVerificationBlockedPayload(payload: VerificationBlockedPayload): boolean {
  const text = [
    payload.message,
    payload.responseBody,
    payload.data == null ? '' : typeof payload.data === 'string' ? payload.data : JSON.stringify(payload.data),
  ].filter(Boolean).join(' ').toLowerCase()

  if (!text) return false
  return VERIFICATION_BLOCK_PATTERNS.some(pattern => text.includes(pattern.toLowerCase()))
}

export function isVerificationBlockedResult(result?: TestResult | null): boolean {
  return result?.error === 'verification_blocked'
}

export function isCheckinFinishedForToday(site: Site, today: string): boolean {
  if (site.checkinDate !== today || !site.checkinStatus) return false
  if (site.checkinFinal === true) return true
  if (site.checkinStatus.isSuccess) return true
  if (site.verificationTabOpenedDate === today) return true
  if (site.checkinStatus.errorMessage === 'verification_blocked') return true
  if ((site.checkinRetryCount ?? 0) >= 1) return true
  return false
}

export function isSiteDueForAutoCheckin(site: Site, today: string, now: Date): boolean {
  if (!site.autoCheckin) return false
  if (isCheckinFinishedForToday(site, today)) return false

  const nowMs = now.getTime()
  if (site.checkinDate === today && site.checkinStatus) {
    if ((site.checkinRetryCount ?? 0) >= 1) return false
    return typeof site.nextCheckinRetryAt === 'number' && nowMs >= site.nextCheckinRetryAt
  }

  if (!site.checkinTimeRange) return true

  const { startHour, endHour, scheduledMinute } = site.checkinTimeRange
  const currentMinuteOfDay = now.getHours() * 60 + now.getMinutes()
  const startMinuteOfDay = startHour * 60
  const endMinuteOfDay = endHour * 60

  if (startHour <= endHour) {
    if (currentMinuteOfDay < startMinuteOfDay || currentMinuteOfDay >= endMinuteOfDay) return false
  } else if (currentMinuteOfDay < startMinuteOfDay && currentMinuteOfDay >= endMinuteOfDay) {
    return false
  }

  if (scheduledMinute == null) return true

  const targetMinuteOfDay = (startMinuteOfDay + scheduledMinute) % (24 * 60)
  if (startHour <= endHour) {
    return currentMinuteOfDay >= targetMinuteOfDay
  }
  return currentMinuteOfDay >= targetMinuteOfDay || currentMinuteOfDay < endMinuteOfDay
}

export function buildCheckinAttemptUpdate({
  site,
  result,
  today,
  nowMs,
  isRetry,
}: CheckinAttemptUpdateOptions): CheckinAttemptUpdate {
  const status = {
    lastTestTime: nowMs,
    isSuccess: result.success,
    statusCode: result.statusCode,
    errorMessage: result.error,
    responseBody: result.responseBody,
  }

  if (result.success) {
    return {
      shouldOpenVerificationTab: false,
      updates: {
        checkinStatus: status,
        checkinDate: today,
        checkinFinal: true,
        checkinRetryCount: isRetry ? 1 : (site.checkinRetryCount ?? 0),
        nextCheckinRetryAt: undefined,
      },
    }
  }

  if (isVerificationBlockedResult(result)) {
    return {
      shouldOpenVerificationTab: site.verificationTabOpenedDate !== today,
      updates: {
        checkinStatus: status,
        checkinDate: today,
        checkinFinal: true,
        checkinRetryCount: isRetry ? 1 : (site.checkinRetryCount ?? 0),
        nextCheckinRetryAt: undefined,
        verificationTabOpenedDate: today,
      },
    }
  }

  if (isRetry || (site.checkinRetryCount ?? 0) >= 1) {
    return {
      shouldOpenVerificationTab: false,
      updates: {
        checkinStatus: status,
        checkinDate: today,
        checkinFinal: true,
        checkinRetryCount: 1,
        nextCheckinRetryAt: undefined,
      },
    }
  }

  return {
    shouldOpenVerificationTab: false,
    updates: {
      checkinStatus: status,
      checkinDate: today,
      checkinFinal: false,
      checkinRetryCount: 0,
      nextCheckinRetryAt: nowMs + CHECKIN_RETRY_DELAY_MS,
    },
  }
}
