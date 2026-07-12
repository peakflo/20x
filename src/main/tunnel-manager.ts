import { Tunnel } from 'cloudflared'

let activeTunnel: Tunnel | null = null
let tunnelUrl: string | null = null

export async function startTunnel(port: number): Promise<string> {
  if (activeTunnel && tunnelUrl) return tunnelUrl

  return new Promise((resolve, reject) => {
    const t = Tunnel.quick(`http://localhost:${port}`)

    // cloudflared prints the public https://<...>.trycloudflare.com URL to its
    // output BEFORE it has actually registered any connections with Cloudflare's
    // edge. If we hand that URL back immediately (on the `url` event), opening it
    // returns a Cloudflare "Argo Tunnel error" (1033/530) until the edge
    // connections come up a few seconds later — and NEVER works at all if the
    // outbound connection can't be established (e.g. QUIC/UDP 7844 or the HTTP2
    // fallback is blocked by a firewall). That is the "URL is generated but
    // doesn't work" symptom. So we capture the URL on `url` but only resolve
    // once at least one connection is `connected`.
    let pendingUrl: string | null = null
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      t.stop()
      activeTunnel = null
      tunnelUrl = null
      reject(
        new Error(
          pendingUrl
            ? 'Tunnel URL was created but never connected to Cloudflare within 30s. ' +
              'The network/firewall may be blocking cloudflared (UDP 7844 / outbound HTTPS).'
            : 'Tunnel start timed out after 30s'
        )
      )
    }, 30000)

    t.on('url', (url) => {
      pendingUrl = url
    })

    t.on('connected', () => {
      if (settled || !pendingUrl) return
      settled = true
      clearTimeout(timer)
      activeTunnel = t
      tunnelUrl = pendingUrl
      resolve(pendingUrl)
    })

    t.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      t.stop()
      activeTunnel = null
      tunnelUrl = null
      reject(err)
    })

    // If cloudflared exits (crash, killed, or network drop) reset cached state so
    // a later startTunnel()/getTunnelUrl() doesn't keep handing back a dead URL.
    t.on('exit', () => {
      if (t === activeTunnel) {
        activeTunnel = null
        tunnelUrl = null
      }
    })
  })
}

export function stopTunnel(): void {
  activeTunnel?.stop()
  activeTunnel = null
  tunnelUrl = null
}

export function getTunnelUrl(): string | null {
  return tunnelUrl
}

export function isTunnelActive(): boolean {
  return activeTunnel !== null
}
