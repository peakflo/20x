import { createHash } from 'node:crypto'

/** Same normalisation as the harness's `--control-plane` check: origin + path, no trailing slash. */
export function normaliseControlPlane(url: string): string {
  const parsed = new URL(url)
  return parsed.origin + parsed.pathname.replace(/\/+$/, '')
}

/**
 * The service instance `connect` installs for "this computer":
 * `computer-` + the first 24 hex of sha256(`<controlPlane>:<tenantId>:<ownerUserId>`),
 * as the harness computes it after approval. Ids are not secrets.
 *
 * A server-reported `serviceInstance` on `/byo/machines` takes precedence
 * (see `serviceInstancesOf`); this is the fallback until it exists.
 */
export function computerServiceInstance(controlPlane: string, tenantId: string, ownerUserId: string): string {
  const scope = createHash('sha256')
    .update(`${normaliseControlPlane(controlPlane)}:${tenantId}:${ownerUserId}`)
    .digest('hex')
    .slice(0, 24)
  return `computer-${scope}`
}
