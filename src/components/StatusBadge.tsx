import React from 'react'
import type { TestStatus } from '../types'

interface StatusBadgeProps {
  status?: TestStatus
}

export function StatusBadge({ status }: StatusBadgeProps) {
  if (!status) {
    return (
      <span className="font-mono text-[11px] text-zinc-400 tracking-tight">
        --
      </span>
    )
  }

  if (status.isSuccess) {
    return (
      <span className="font-mono text-[11px] text-emerald-500 tracking-tight">
        {status.statusCode || 200}
      </span>
    )
  }

  return (
    <span className="font-mono text-[11px] text-red-400 tracking-tight">
      {status.statusCode || status.errorMessage?.slice(0, 12) || 'ERR'}
    </span>
  )
}
