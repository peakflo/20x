import { Tunnel } from 'cloudflared'

let activeTunnel: Tunnel | null = null
let tunnelUrl: string | null = null

export async function startTunnel(port: number): Promise<string> {
  if (activeTunnel && tunnelUrl) return tunnelUrl

  return new Promise((resolve, reject) => {
    const t = Tunnel.quick(`http://localhost:${port}`)

    const timer = setTimeout(() => {
      t.stop()
      reject(new Error('Tunnel start timed out after 30s'))
    }, 30000)

    t.on('url', (url) => {
      clearTimeout(timer)
      activeTunnel = t
      tunnelUrl = url
      resolve(url)
    })

    t.on('error', (err) => {
      clearTimeout(timer)
      activeTunnel = null
      tunnelUrl = null
      reject(err)
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
