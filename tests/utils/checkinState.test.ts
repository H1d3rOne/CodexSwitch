import { describe, expect, it } from 'vitest'
import type { Site, TestResult } from '../../src/types'
import {
  CHECKIN_RETRY_DELAY_MS,
  buildCheckinAttemptUpdate,
  isCheckinFinishedForToday,
  isSiteDueForAutoCheckin,
  isVerificationBlockedPayload,
} from '../../src/utils/checkinState'

function site(overrides: Partial<Site> = {}): Site {
  return {
    id: 'site-1',
    name: 'Site 1',
    url: 'https://example.com',
    autoCheckin: true,
    checkinTimeRange: { startHour: 6, endHour: 7, scheduledMinute: 15 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('checkin state machine', () => {
  const today = '2026-05-22'
  const scheduledTime = new Date('2026-05-22T06:15:00+08:00')
  const afterScheduledTime = new Date('2026-05-22T06:16:00+08:00')

  it('runs an initial auto check-in only after the scheduled time', () => {
    expect(isSiteDueForAutoCheckin(site(), today, scheduledTime)).toBe(true)
    expect(isSiteDueForAutoCheckin(site(), today, new Date('2026-05-22T06:14:00+08:00'))).toBe(false)
  })

  it('marks a successful check-in as final for today', () => {
    const result: TestResult = { success: true, statusCode: 200, message: 'ok' }

    const attempt = buildCheckinAttemptUpdate({
      site: site(),
      result,
      today,
      nowMs: afterScheduledTime.getTime(),
      isRetry: false,
    })

    expect(attempt.shouldOpenVerificationTab).toBe(false)
    expect(attempt.updates.checkinFinal).toBe(true)
    expect(attempt.updates.nextCheckinRetryAt).toBeUndefined()
    expect(isCheckinFinishedForToday({ ...site(), ...attempt.updates }, today)).toBe(true)
  })

  it('schedules exactly one retry ten minutes after a normal first failure', () => {
    const result: TestResult = { success: false, statusCode: 500, message: 'server error', error: 'server error' }
    const nowMs = afterScheduledTime.getTime()

    const attempt = buildCheckinAttemptUpdate({
      site: site(),
      result,
      today,
      nowMs,
      isRetry: false,
    })
    const updatedSite = { ...site(), ...attempt.updates }

    expect(attempt.shouldOpenVerificationTab).toBe(false)
    expect(attempt.updates.checkinFinal).toBe(false)
    expect(attempt.updates.checkinRetryCount).toBe(0)
    expect(attempt.updates.nextCheckinRetryAt).toBe(nowMs + CHECKIN_RETRY_DELAY_MS)
    expect(isCheckinFinishedForToday(updatedSite, today)).toBe(false)
    expect(isSiteDueForAutoCheckin(updatedSite, today, new Date(nowMs + CHECKIN_RETRY_DELAY_MS - 1))).toBe(false)
    expect(isSiteDueForAutoCheckin(updatedSite, today, new Date(nowMs + CHECKIN_RETRY_DELAY_MS))).toBe(true)
  })

  it('marks the retry result as final and prevents further automatic attempts', () => {
    const retrySite = site({
      checkinDate: today,
      checkinStatus: { lastTestTime: afterScheduledTime.getTime(), isSuccess: false, errorMessage: 'server error' },
      checkinRetryCount: 0,
      nextCheckinRetryAt: afterScheduledTime.getTime() + CHECKIN_RETRY_DELAY_MS,
      checkinFinal: false,
    })
    const result: TestResult = { success: false, statusCode: 500, message: 'server error', error: 'server error' }

    const attempt = buildCheckinAttemptUpdate({
      site: retrySite,
      result,
      today,
      nowMs: afterScheduledTime.getTime() + CHECKIN_RETRY_DELAY_MS,
      isRetry: true,
    })
    const updatedSite = { ...retrySite, ...attempt.updates }

    expect(attempt.updates.checkinFinal).toBe(true)
    expect(attempt.updates.checkinRetryCount).toBe(1)
    expect(attempt.updates.nextCheckinRetryAt).toBeUndefined()
    expect(isCheckinFinishedForToday(updatedSite, today)).toBe(true)
    expect(isSiteDueForAutoCheckin(updatedSite, today, new Date('2026-05-22T06:40:00+08:00'))).toBe(false)
  })

  it('opens a verification tab once on the first blocked attempt and finishes the site for today', () => {
    const result: TestResult = {
      success: false,
      statusCode: 403,
      message: '签到需要验证',
      error: 'verification_blocked',
    }

    const attempt = buildCheckinAttemptUpdate({
      site: site(),
      result,
      today,
      nowMs: afterScheduledTime.getTime(),
      isRetry: false,
    })
    const updatedSite = { ...site(), ...attempt.updates }

    expect(attempt.shouldOpenVerificationTab).toBe(true)
    expect(attempt.updates.checkinFinal).toBe(true)
    expect(attempt.updates.verificationTabOpenedDate).toBe(today)
    expect(attempt.updates.nextCheckinRetryAt).toBeUndefined()
    expect(isCheckinFinishedForToday(updatedSite, today)).toBe(true)
    expect(isSiteDueForAutoCheckin(updatedSite, today, new Date('2026-05-22T06:40:00+08:00'))).toBe(false)
  })

  it('detects Cloudflare and captcha challenge responses as verification blocks', () => {
    expect(isVerificationBlockedPayload({
      statusCode: 403,
      responseBody: '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></html>',
    })).toBe(true)

    expect(isVerificationBlockedPayload({
      statusCode: 400,
      message: '请先完成人机验证',
      data: { component: 'cf-turnstile' },
    })).toBe(true)
  })

  it('does not treat normal token or cookie failures as verification blocks', () => {
    expect(isVerificationBlockedPayload({
      statusCode: 401,
      message: 'invalid token',
      data: { error: 'token expired' },
    })).toBe(false)

    expect(isVerificationBlockedPayload({
      statusCode: 401,
      message: 'Cookie 已失效，请重新登录',
    })).toBe(false)

    expect(isVerificationBlockedPayload({
      statusCode: 403,
      message: '签名验证失败',
    })).toBe(false)
  })
})
