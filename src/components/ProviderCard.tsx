import React from 'react'
import type { Provider } from '../types'
import { StatusBadge } from './StatusBadge'

interface ProviderCardProps {
  provider: Provider
  onTest: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  showActions?: boolean
}

export function ProviderCard({
  provider,
  onTest,
  onEdit,
  onDelete,
  showActions = true,
}: ProviderCardProps) {
  return (
    <div className="border rounded-lg p-4 mb-3 bg-white shadow-sm">
      <div className="flex justify-between items-start mb-2">
        <div>
          <h3 className="font-semibold text-lg">{provider.name}</h3>
          <p className="text-sm text-gray-600">{provider.baseUrl}</p>
        </div>
        <StatusBadge status={provider.testStatus} />
      </div>

      {showActions && (
        <div className="flex gap-2 mt-3">
          <button
            onClick={() => onTest(provider.id)}
            className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            测试
          </button>
          <button
            onClick={() => onEdit(provider.id)}
            className="px-3 py-1 text-sm bg-gray-500 text-white rounded hover:bg-gray-600"
          >
            编辑
          </button>
          <button
            onClick={() => onDelete(provider.id)}
            className="px-3 py-1 text-sm bg-red-500 text-white rounded hover:bg-red-600"
          >
            删除
          </button>
        </div>
      )}
    </div>
  )
}
