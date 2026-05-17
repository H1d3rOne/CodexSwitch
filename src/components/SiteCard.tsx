import React from 'react'
import type { Site, TestStatus, CookieStatus } from '../types'

interface SiteCardProps {
  site: Site
  onTest: (id: string) => void
  onCheckin: (id: string) => void
  onEdit: (site: Site) => void
  onDelete: (id: string) => void
  onRefreshBalance: (id: string) => void
  testing?: boolean
  checkingIn?: boolean
  refreshingBalance?: boolean
}

function getTestLabel(status?: TestStatus, loading?: boolean): string {
  if (loading) return 'Testing...'
  if (!status) return 'Test'
  if (status.isSuccess) return `${status.statusCode || 'OK'}`
  return status.errorMessage || `${status.statusCode || 'Fail'}`
}

function buildTooltip(status?: TestStatus): string {
  if (!status) return ''
  const parts: string[] = []
  if (status.statusCode) parts.push(`Status: ${status.statusCode}`)
  if (status.isSuccess) parts.push('Success')
  else if (status.errorMessage) parts.push(`Error: ${status.errorMessage}`)
  if (status.responseBody) parts.push(`Response: ${status.responseBody.slice(0, 200)}`)
  return parts.join('\n')
}

function statusBtnClass(status?: TestStatus, defaultClass?: string): string {
  if (!status) return defaultClass || 'bg-slate-100 text-slate-500'
  if (status.isSuccess) return 'bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200/60'
  return 'bg-red-50 text-red-500 ring-1 ring-red-200/60'
}

export function SiteCard({ site, onTest, onCheckin, onEdit, onDelete, onRefreshBalance, testing, checkingIn, refreshingBalance }: SiteCardProps) {
  const urlObj = (() => { try { return new URL(site.url) } catch { return null } })()

  return (
    <div className="group p-3 bg-white rounded-xl ring-1 ring-slate-300/80 hover:ring-blue-300 transition-all">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <div className="text-[12px] font-semibold text-slate-800 truncate">{site.name}</div>
            {site.balance && (
              <span className="shrink-0 px-1.5 py-px text-[9px] font-bold rounded-full bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200/50">
                {site.balance}
              </span>
            )}
            {site.authType === 'cookie' && site.cookieStatus && (
              <span className={`shrink-0 px-1 py-px text-[7px] font-bold uppercase tracking-wider rounded ${
                site.cookieStatus === 'valid' ? 'bg-emerald-50 text-emerald-500 ring-1 ring-emerald-200' :
                site.cookieStatus === 'invalid' ? 'bg-red-50 text-red-500 ring-1 ring-red-200' :
                'bg-slate-100 text-slate-400 ring-1 ring-slate-200'
              }`}>
                {site.cookieStatus === 'valid' ? 'Cookie OK' : site.cookieStatus === 'invalid' ? 'Cookie Invalid' : 'Cookie ?'}
              </span>
            )}
          </div>
          <div className="text-[10px] text-slate-400 font-mono truncate mt-0.5">{urlObj?.hostname || site.url}</div>
        </div>

        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 shrink-0">
          <button onClick={() => onRefreshBalance(site.id)}
            disabled={refreshingBalance}
            title="Refresh balance"
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-emerald-50 transition-colors">
            {refreshingBalance ? (
              <svg className="w-2.5 h-2.5 animate-spin text-emerald-400" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
            ) : (
              <svg className="w-2.5 h-2.5 text-slate-400 hover:text-emerald-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
            )}
          </button>
          <button onClick={() => onEdit(site)}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-blue-50 transition-colors">
            <svg className="w-2.5 h-2.5 text-slate-400 hover:text-blue-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" /></svg>
          </button>
          <button onClick={() => onDelete(site.id)}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-50 transition-colors">
            <svg className="w-2.5 h-2.5 text-slate-400 hover:text-red-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      </div>

      {site.autoCheckin && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="px-1 py-px text-[7px] font-bold uppercase tracking-wider rounded bg-blue-50 text-blue-500">api</span>
          {site.checkinTimeRange && site.checkinTimeRange.scheduledMinute != null && (
            <span className="text-[8px] text-blue-400 font-medium">
              {site.checkinTimeRange.startHour + Math.floor(site.checkinTimeRange.scheduledMinute / 60)}:{String(site.checkinTimeRange.scheduledMinute % 60).padStart(2, '0')}
            </span>
          )}
          <span className={`w-1.5 h-1.5 rounded-full ${site.autoCheckin ? 'bg-emerald-400' : 'bg-slate-300'}`} />
        </div>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <button
          onClick={() => onTest(site.id)}
          disabled={testing}
          title={buildTooltip(site.testStatus)}
          className={`flex items-center gap-1 px-2 py-1 text-[9px] font-medium rounded-md transition-colors disabled:opacity-40 ${statusBtnClass(site.testStatus)}`}
        >
          {testing ? (
            <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
          ) : site.testStatus?.isSuccess ? (
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          ) : site.testStatus && !site.testStatus.isSuccess ? (
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
          ) : (
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
          )}
          {getTestLabel(site.testStatus, testing)}
        </button>

        {site.autoCheckin && (
          <button
            onClick={() => onCheckin(site.id)}
            disabled={checkingIn}
            title={buildTooltip(site.checkinStatus)}
            className={`flex items-center gap-1 px-2 py-1 text-[9px] font-medium rounded-md transition-colors disabled:opacity-40 ${statusBtnClass(site.checkinStatus, 'bg-amber-50 text-amber-600')}`}
          >
            {checkingIn ? (
              <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
            ) : site.checkinStatus?.isSuccess ? (
              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            ) : site.checkinStatus && !site.checkinStatus.isSuccess ? (
              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
            ) : (
              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            )}
            {checkingIn ? 'Signing...' : site.checkinStatus?.isSuccess ? 'Done' : site.checkinStatus && !site.checkinStatus.isSuccess ? 'Failed' : 'Check-in'}
          </button>
        )}
      </div>
    </div>
  )
}
