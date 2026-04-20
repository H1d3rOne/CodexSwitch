import React from 'react'
import type { Site, TestStatus } from '../types'

interface SiteCardProps {
  site: Site
  onTest: (id: string) => void
  onCheckin: (id: string) => void
  onEdit: (site: Site) => void
  onDelete: (id: string) => void
  testing?: boolean
  checkingIn?: boolean
}

function getTestLabel(status?: TestStatus, loading?: boolean): string {
  if (loading) return 'Testing...'
  if (!status) return 'Test'
  if (status.isSuccess) return `${status.statusCode || 'OK'}`
  return status.errorMessage || `${status.statusCode || 'Fail'}`
}

function getCheckinLabel(checkingIn?: boolean): string {
  return checkingIn ? 'Signing...' : 'Check-in'
}

export function SiteCard({ site, onTest, onCheckin, onEdit, onDelete, testing, checkingIn }: SiteCardProps) {
  const urlObj = (() => { try { return new URL(site.url) } catch { return null } })()

  return (
    <div className="group p-3 bg-white rounded-xl ring-1 ring-slate-200/80 hover:ring-blue-200/60 transition-all">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-slate-800 truncate">{site.name}</div>
          <div className="text-[10px] text-slate-400 font-mono truncate mt-0.5">{urlObj?.hostname || site.url}</div>
        </div>

        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 shrink-0">
          <button onClick={() => onDelete(site.id)}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-50 transition-colors">
            <svg className="w-2.5 h-2.5 text-slate-300 hover:text-red-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <button
          onClick={() => onTest(site.id)}
          disabled={testing}
          className={`flex items-center gap-1 px-2 py-1 text-[9px] font-medium rounded-md transition-colors disabled:opacity-40 ${site.testStatus?.isSuccess ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-600 hover:bg-blue-50 hover:text-blue-600'}`}
        >
          {testing ? (
            <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
          ) : (
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
          )}
          {getTestLabel(site.testStatus, testing)}
        </button>

        {site.checkinUrl && (
          <button
            onClick={() => onCheckin(site.id)}
            disabled={checkingIn}
            className="flex items-center gap-1 px-2 py-1 text-[9px] font-medium rounded-md bg-amber-50 text-amber-600 hover:bg-amber-100 transition-colors disabled:opacity-40"
          >
            {checkingIn ? (
              <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
            ) : (
              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            )}
            {getCheckinLabel(checkingIn)}
          </button>
        )}

        {!site.checkinUrl && (
          <button onClick={() => onEdit(site)}
            className="ml-auto flex items-center gap-1 px-2 py-1 text-[9px] font-medium text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-md transition-colors">
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" /></svg>
            Config
          </button>
        )}
      </div>

      {site.testStatus && !site.testStatus.isSuccess && (
        <div className="mt-1.5 text-[9px] text-red-500 truncate">{site.testStatus.errorMessage}</div>
      )}
    </div>
  )
}
