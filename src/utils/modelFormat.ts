import type { ApiType, ModelEntry, ProviderFormat } from '../types'

const FORMAT_OPENAI = 'openai'
const FORMAT_ANTHROPIC = 'anthropic'
const FORMAT_AUTO = 'auto'

export function normalizeModelEntry(
  model: ModelEntry | string | null | undefined,
  fallbackApiType: ApiType = 'both',
  fallbackFormat?: ProviderFormat,
): ModelEntry | null {
  const rawName = typeof model === 'string' ? model : model?.name
  const name = String(rawName || '').trim()
  if (!name || name.toLowerCase() === FORMAT_AUTO) return null

  let apiType = fallbackApiType
  let explicitFormat: ProviderFormat | undefined
  if (typeof model !== 'string' && model) {
    apiType = model.apiType || fallbackApiType
    explicitFormat = model.format
  }
  const format = explicitFormat || getModelFormat(name) || fallbackFormat
  return format ? { name, apiType, format } : { name, apiType }
}

export function normalizeModelList(
  models: Array<ModelEntry | string> | readonly (ModelEntry | string)[] | undefined,
  fallbackApiType: ApiType = 'both',
  fallbackFormat?: ProviderFormat,
): ModelEntry[] {
  const seen = new Set<string>()
  const normalized: ModelEntry[] = []

  for (const model of models || []) {
    const entry = normalizeModelEntry(model, fallbackApiType, fallbackFormat)
    if (!entry) continue
    const key = `${entry.format || fallbackFormat || ''}:${entry.name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(entry)
  }

  return normalized
}

export function filterModelsForFormat(models: ModelEntry[], format: ProviderFormat): ModelEntry[] {
  return normalizeModelList(models, format === 'anthropic' ? 'chat' : 'both', format)
    .filter(model => {
      if (model.format) return model.format === format
      const inferredFormat = getModelFormat(model.name)
      return !inferredFormat || inferredFormat === format
    })
    .map(model => ({ ...model, format }))
}

export function getModelFormat(modelName: string): ProviderFormat | null {
  const name = modelName.trim().toLowerCase()
  if (!name || name === FORMAT_AUTO) return null
  if (name.startsWith('claude-')) return FORMAT_ANTHROPIC
  if (
    name.startsWith('gpt-') ||
    name.startsWith('o1') ||
    name.startsWith('o3') ||
    name.startsWith('o4') ||
    name.startsWith('text-') ||
    name.startsWith('davinci') ||
    name.includes('chatgpt')
  ) {
    return FORMAT_OPENAI
  }
  return null
}

export function filterModelNamesForFormat(names: string[], format: ProviderFormat): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const rawName of names) {
    const name = String(rawName || '').trim()
    if (!name || name.toLowerCase() === FORMAT_AUTO) continue

    const inferredFormat = getModelFormat(name)
    if (inferredFormat && inferredFormat !== format) continue

    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(name)
  }

  return result
}

export function normalizeGroupModelsForFormat(
  groupModels: Record<string, Array<ModelEntry | string>> | undefined,
  format: ProviderFormat,
  fallbackApiType: ApiType = format === 'anthropic' ? 'chat' : 'both',
): Record<string, ModelEntry[]> {
  return Object.fromEntries(
    Object.entries(groupModels || { default: [] }).map(([group, models]) => [
      group,
      filterModelsForFormat(normalizeModelList(models, fallbackApiType, format), format),
    ])
  )
}

export function normalizeFormatModels(
  formatModels: Partial<Record<ProviderFormat, Array<ModelEntry | string>>> | undefined,
): Partial<Record<ProviderFormat, ModelEntry[]>> {
  return {
    openai: filterModelsForFormat(normalizeModelList(formatModels?.openai, 'both', 'openai'), 'openai'),
    anthropic: filterModelsForFormat(normalizeModelList(formatModels?.anthropic, 'chat', 'anthropic'), 'anthropic'),
  }
}

export function normalizeFormatGroupModels(
  formatGroupModels: Partial<Record<ProviderFormat, Record<string, Array<ModelEntry | string>>>> | undefined,
): Partial<Record<ProviderFormat, Record<string, ModelEntry[]>>> {
  return {
    openai: normalizeGroupModelsForFormat(formatGroupModels?.openai, 'openai', 'both'),
    anthropic: normalizeGroupModelsForFormat(formatGroupModels?.anthropic, 'anthropic', 'chat'),
  }
}

function pushDeduped(target: ModelEntry[], model: ModelEntry) {
  if (!target.some(item => item.name.toLowerCase() === model.name.toLowerCase())) {
    target.push(model)
  }
}

export function splitGroupModelsByFormat(
  groupModels: Record<string, Array<ModelEntry | string>> | undefined,
  fallbackFormat: ProviderFormat,
  fallbackApiType: ApiType = fallbackFormat === 'anthropic' ? 'chat' : 'both',
): Record<ProviderFormat, Record<string, ModelEntry[]>> {
  const result: Record<ProviderFormat, Record<string, ModelEntry[]>> = {
    openai: {},
    anthropic: {},
  }

  for (const [group, models] of Object.entries(groupModels || { default: [] })) {
    result.openai[group] = result.openai[group] || []
    result.anthropic[group] = result.anthropic[group] || []

    for (const rawModel of models || []) {
      const model = normalizeModelEntry(rawModel, fallbackApiType, fallbackFormat)
      if (!model) continue
      const format = model.format || fallbackFormat
      pushDeduped(result[format][group], { ...model, format })
    }
  }

  if (!result.openai.default) result.openai.default = []
  if (!result.anthropic.default) result.anthropic.default = []

  return result
}

export function hasAnyModels(groupModels?: Record<string, ModelEntry[]>): boolean {
  return Object.values(groupModels || {}).some(models => models.length > 0)
}
