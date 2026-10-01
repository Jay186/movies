import { h3ProviderProfile } from './h3.js'

const providers = new Map([
  [h3ProviderProfile.id, h3ProviderProfile],
])

export const DEFAULT_STORYBOARD_PROVIDER_ID = h3ProviderProfile.id

export function getStoryboardProvider(providerId = DEFAULT_STORYBOARD_PROVIDER_ID) {
  return providers.get(providerId) || providers.get(DEFAULT_STORYBOARD_PROVIDER_ID)
}

export function listStoryboardProviders() {
  return [...providers.values()]
}
