
export function resolveMc({ explicit, globalEnabled, crossScene }) {
  if (crossScene) return { wanted: false, reason: 'cross-scene' }
  if (explicit === true) return { wanted: true, reason: 'explicit-on' }
  if (explicit === false) return { wanted: false, reason: 'explicit-off' }
  return { wanted: globalEnabled === true, reason: globalEnabled === true ? 'global-on' : 'global-off' }
}
