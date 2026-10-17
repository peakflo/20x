/** Read the selected company once, then use change events from the main process. */
export function createBrandFlagCache(readCurrent: () => boolean): {
  get: () => boolean
  update: (enabled: boolean) => void
} {
  let cached: boolean | undefined
  return {
    get: () => {
      if (cached === undefined) cached = readCurrent()
      return cached
    },
    update: (enabled) => { cached = enabled }
  }
}
