import React from 'react'
import type { TestStatus } from '../types'

interface StatusBadgeProps {
  status?: TestStatus
}

export function StatusBadge({ status }: StatusBadgeProps) {
  if (!status) {
    return (
      <span className="inline-flex items-center justify-center min-w-[36px] px-1.5 py-0.5 rounded text-[11px] font-mono font-medium bg-white/[0.04] text-white/20">
        --
      </span>
    )
  }

  if (status.isSuccess) {
    return (
      <span className="inline-flex items-center justify-center min-w-[36px] px-1.5 py-0.5 rounded text-[11px] font-mono font-semibold bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20">
        {status.statusCode ?? 200}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center justify-center min-w-[36px] px-1.5 py-0.5 rounded text-[11px] font-mono font-semibold bg-red-500/15 text-red-400 ring-1 ring-red-500/20">
      {status.statusCode ?? 'ERR'}
    </span>
  )
}
