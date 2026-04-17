import React from 'react'
import type { TestStatus } from '../types'

interface StatusBadgeProps {
  status?: TestStatus
  loading?: boolean
}

export function StatusBadge({ status, loading }: StatusBadgeProps) {
  if (loading) {
    return (
      <span className="inline-flex items-center justify-center min-w-[38px] px-2 py-0.5 rounded-md text-[11px] font-mono font-semibold bg-blue-50 text-blue-500 ring-1 ring-blue-200">
        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
      </span>
    )
  }

  if (!status) {
    return (
      <span className="inline-flex items-center justify-center min-w-[38px] px-2 py-0.5 rounded-md text-[11px] font-mono font-semibold bg-slate-100 text-slate-300">
        --
      </span>
    )
  }

  const tooltipText = status.responseBody
    ? status.responseBody
    : status.errorMessage || (status.isSuccess ? 'OK' : 'Error')

  if (status.isSuccess) {
    return (
      <span className="inline-flex items-center justify-center min-w-[38px] px-2 py-0.5 rounded-md text-[11px] font-mono font-bold bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200 cursor-default" title={tooltipText}>
        {status.statusCode ?? 200}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center justify-center min-w-[38px] px-2 py-0.5 rounded-md text-[11px] font-mono font-bold bg-red-50 text-red-500 ring-1 ring-red-200 cursor-default" title={tooltipText}>
      {status.statusCode ?? 'ERR'}
    </span>
  )
}
