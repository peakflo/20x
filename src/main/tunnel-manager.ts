import { Tunnel, DEFAULT_CLOUDFLARED_BIN, use as useCloudflaredBin } from 'cloudflared'
import { writeFileSync, existsSync } from 'fs'
import { join, sep } from 'path'
import { tmpdir } from 'os'
import { app } from 'electron'

// The cloudflared package resolves its bundled binary via `__dirname`, which
// in a packaged app points inside app.asar. Electron's fs APIs are
// asar-transparent for reads, but spawning a binary from inside the asar
// fails (ENOENT) — electron-builder's asarUnpack only extracts the real file
// to the sibling `app.asar.unpacked` directory, so spawn must be told to use
// that path explicitly.
if (app.isPackaged) {
  const unpackedBin = DEFAULT_CLOUDFLARED_BIN.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  if (existsSync(unpackedBin)) {
    useCloudflaredBin(unpackedBin)
  } else {
    console.warn('[tunnel] expected unpacked cloudflared binary not found at', unpackedBin)
  }
}

let activeTunnel: Tunnel | null = null
let tunnelUrl: string | null = null

/**
 * cloudflared auto-loads a default config file (~/.cloudflared/config.yml, etc.)
 * even for `--url` quick tunnels. If the user has one from another tool (e.g. a
 * `daytona_proxy` named tunnel), its `ingress:` rules take over and the quick
 * tunnel's hostname matches none of them, so every request falls through to the
 * catch-all `service: http_status:404` — the tunnel connects and the URL is
 * generated, but every request returns 404 and never reaches our local server.
 * Point cloudflared at our own empty config so it ignores the user's file and
 * uses the plain `--url` quick-tunnel ingress. Returns the config path.
 */
function ensureIsolatedConfig(): string {
  const path = join(tmpdir(), '20x-cloudflared-empty.yml')
  // Empty file → no ingress rules → quick tunnel proxies `--url` normally.
  writeFileSync(path, '')
  return path
}

// cloudflared can be slow to register its first edge connection when the local
// DNS resolver is degraded — e.g. a VPN like Tailscale MagicDNS intercepting DNS
// makes every `*.argotunnel.com` lookup time out (~20–40s each) before cloudflared
// falls back, so a working tunnel can take 60–80s to actually connect. Give it
// enough headroom that a genuinely-working-but-slow environment isn't rejected.
const CONNECT_TIMEOUT_MS = 120_000

export async function startTunnel(port: number): Promise<string> {
  if (activeTunnel && tunnelUrl) return tunnelUrl

  return new Promise((resolve, reject) => {
    // Options passed to cloudflared. build_options() uses the key verbatim, so
    // each flag must include the leading dashes.
    //  --config <empty>: ignore any user ~/.cloudflared/config.yml whose ingress
    //    rules would otherwise route every request to `http_status:404` (see
    //    ensureIsolatedConfig). This is the root-cause fix for "URL generates but
    //    doesn't work" — without it the tunnel connects but returns 404 for all
    //    requests.
    //  --edge-ip-version 4: cloudflared otherwise resolves/dials Cloudflare's edge
    //    over IPv6 first. On machines behind a VPN (notably Tailscale MagicDNS at
    //    fd7a:115c:a1e0::53) the IPv6 DNS path for *.argotunnel.com times out,
    //    pushing first-connection to ~70–80s. Forcing the IPv4 edge connects in
    //    a few seconds.
    // Origin uses 127.0.0.1 (not `localhost`) because the mobile server binds
    // IPv4 only (0.0.0.0); `localhost` can resolve to ::1 first and fail to dial.
    let options: Record<string, string | number> = { '--edge-ip-version': 4 }
    try {
      options = { '--config': ensureIsolatedConfig(), ...options }
    } catch (e) {
      console.warn('[tunnel] could not write isolated cloudflared config, using default:', e)
    }
    const t = Tunnel.quick(`http://127.0.0.1:${port}`, options)

    // cloudflared prints the public https://<...>.trycloudflare.com URL to its
    // output BEFORE it has actually registered any connection with Cloudflare's
    // edge. If we hand that URL back immediately (on the `url` event), opening it
    // returns a Cloudflare "Argo Tunnel error" (1033/530) until the edge
    // connection comes up — and NEVER works if the connection can't be
    // established at all. That is the "URL is generated but doesn't work"
    // symptom. So we capture the URL on `url` but only resolve once at least one
    // connection is `connected`.
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
