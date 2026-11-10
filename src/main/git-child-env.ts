/** Git exports repository paths to hooks. They must not select a different
 * repository when 20x runs Git in an explicit workspace. */
export function gitChildEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...parent }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  return env
}
