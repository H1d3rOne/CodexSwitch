import React from 'react'
import type { TestStatus } from '../types'

interface StatusBadgeProps {
  status?: TestStatus
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  if (hours < 24) return `${hours}小时前`
  return `${days}天前`
}

export function StatusBadge({ status }: StatusBadgeProps) {
  if (!status) {
    return (
      <span className="inline-flex items-center px-2 py-1 rounded text-xs bg-gray-100 text-gray-600">
        未测试
      </span>
    )
  }

  if (status.isSuccess) {
    return (
      <span className="inline-flex items-center px-2 py-1 rounded text-xs bg-green-100 text-green-700">
        ✓ 已验证 ({formatRelativeTime(status.lastTestTime)})
      </span>
    )
  }

  return (
    <span className="inline-flex items-center px-2 py-1 rounded text-xs bg-red-100 text-red-700">
      ✗ 失败 ({status.errorMessage || '未知错误'})
    </span>
  )
}
