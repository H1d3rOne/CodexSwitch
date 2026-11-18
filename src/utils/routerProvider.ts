import type { ModelEntry, Provider, ProviderFormat } from '../types'
import { defaultApiTypeForFormat, normalizeModelList } from './modelFormat'

export function projectRouterProvider(provider: Provider, targetFormat: ProviderFormat): Provider {
  const sourceFormat = provider.format || 'openai'
  if (sourceFormat === targetFormat) return provider

  const apiType = defaultApiTypeForFormat(targetFormat)
  const projectModels = (models: ModelEntry[] | undefined): ModelEntry[] =>
    normalizeModelList(models, provider.apiType || defaultApiTypeForFormat(sourceFormat), sourceFormat)
      .map(model => ({ ...model, format: targetFormat, apiType }))
  const projectGroups = (groups: Record<string, ModelEntry[]>): Record<string, ModelEntry[]> =>
    Object.fromEntries(Object.entries(groups).map(([group, models]) => [group, projectModels(models)]))

  const sourceModels = provider.models || (provider.model ? [{ name: provider.model, apiType: provider.apiType, format: sourceFormat }] : [])
  const sourceGroups = provider.groupModels || provider.formatGroupModels?.[sourceFormat] || { [provider.activeGroup || 'default']: sourceModels }

  return {
    ...provider,
    format: targetFormat,
    apiType,
    models: projectModels(sourceModels),
    groupModels: projectGroups(sourceGroups),
    formatModels: { [targetFormat]: projectModels(provider.formatModels?.[sourceFormat] || sourceModels) },
    formatGroupModels: { [targetFormat]: projectGroups(provider.formatGroupModels?.[sourceFormat] || sourceGroups) },
  }
}

export function selectEffectiveRouterProvider(providers: Provider[], format: ProviderFormat): Provider | undefined {
  return providers.find(provider => provider.routerEffectiveFormats?.includes(format) && ((provider.format || 'openai') === format || provider.formatConversionEnabled))
    || providers.find(provider => provider.routerActiveFormats?.includes(format) && (provider.format || 'openai') !== format && provider.formatConversionEnabled)
}

export function selectRouterProvider(providers: Provider[], format: ProviderFormat): Provider | undefined {
  return selectEffectiveRouterProvider(providers, format)
    || providers.find(provider => provider.isActive && (provider.format || 'openai') === format)
}
