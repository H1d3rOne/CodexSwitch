import React from 'react'
import type { TestStatus } from '../types'

interface StatusBadgeProps {
  status?: TestStatus
}

export function StatusBadge({ status }: StatusBadgeProps) {
  if (!status) {
    return (
      <span className="inline-flex items-center justify-center min-w-[38px] px-2 py-0.5 rounded-md text-[11px] font-mono font-semibold bg-slate-100 text-slate-300">
        --
      </span>
    )
  }

  if (status.isSuccess) {
    return (
      <span className="inline-flex items-center justify-center min-w-[38px] px-2 py-0.5 rounded-md text-[11px] font-mono font-bold bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200">
        {status.statusCode ?? 200}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center justify-center min-w-[38px] px-2 py-0.5 rounded-md text-[11px] font-mono font-bold bg-red-50 text-red-500 ring-1 ring-red-200">
      {status.statusCode ?? 'ERR'}
    </span>
  )
}
