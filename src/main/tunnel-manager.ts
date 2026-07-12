import { Tunnel } from 'cloudflared'

let activeTunnel: Tunnel | null = null
let tunnelUrl: string | null = null

// cloudflared can be slow to register its first edge connection when the local
// DNS resolver is degraded — e.g. a VPN like Tailscale MagicDNS intercepting DNS
// makes every `*.argotunnel.com` lookup time out (~20–40s each) before cloudflared
// falls back, so a working tunnel can take 60–80s to actually connect. Give it
// enough headroom that a genuinely-working-but-slow environment isn't rejected.
const CONNECT_TIMEOUT_MS = 120_000

export async function startTunnel(port: number): Promise<string> {
  if (activeTunnel && tunnelUrl) return tunnelUrl

  return new Promise((resolve, reject) => {
    const t = Tunnel.quick(`http://localhost:${port}`)

    // cloudflared prints the public https://<...>.trycloudflare.com URL to its
    // output BEFORE it has actually registered any connection with Cloudflare's
    // edge. If we hand that URL back immediately (on the `url` event), opening it
    // returns a Cloudflare "Argo Tunnel error" (1033/530) until the edge
    // connection comes up — and NEVER works if the connection can't be
    // established at all (outbound QUIC/UDP 7844 + HTTP2 fallback blocked, or DNS
    // for *.argotunnel.com failing behind a VPN). That is the "URL is generated
    // but doesn't work" symptom. So we capture the URL on `url` but only resolve
    // once at least one connection is `connected`.
    let pendingUrl: string | null = null
    let settled = false
    const recentOutput: string[] = []
    const remember = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed) return
      recentOutput.push(trimmed)
      if (recentOutput.length > 8) recentOutput.shift()
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      t.stop()
      activeTunnel = null
      tunnelUrl = null
      const tail = recentOutput.length ? ` Last cloudflared output:\n${recentOutput.join('\n')}` : ''
      reject(
        new Error(
          pendingUrl
            ? `Tunnel URL was created but never connected to Cloudflare within ${CONNECT_TIMEOUT_MS / 1000}s. ` +
              'A firewall may be blocking cloudflared (outbound UDP 7844 / HTTPS), or a VPN such as ' +
              'Tailscale MagicDNS may be blocking DNS for *.argotunnel.com.' + tail
            : `Tunnel start timed out after ${CONNECT_TIMEOUT_MS / 1000}s.` + tail
        )
      )
    }, CONNECT_TIMEOUT_MS)

    // Surface cloudflared's own logs so connection failures are diagnosable.
    t.on('stdout', (data) => { remember(data); console.log('[cloudflared]', data.trim()) })
    t.on('stderr', (data) => { remember(data); console.log('[cloudflared]', data.trim()) })

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
