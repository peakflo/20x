/**
 * Auth Callback Server
 *
 * Creates a temporary HTTP server on localhost to receive auth callbacks
 * from workflow-builder after browser-based signup/login.
 *
 * Expected callback format:
 *   http://localhost:<port>/auth/callback?access_token=<token>&refresh_token=<token>
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'

export interface AuthCallbackResult {
  access_token: string
  refresh_token: string
}

export class AuthCallbackServer {
  private server: Server | null = null
  private port: number = 48620
  private resolver: ((value: AuthCallbackResult) => void) | null = null
  private rejecter: ((reason: Error) => void) | null = null

  /**
   * Start the local server and return the redirect URI
   */
  async start(): Promise<string> {
    // Try ports 48620-48640 (high port range to avoid conflicts)
    for (let port = 48620; port <= 48640; port++) {
      try {
        await this.startOnPort(port)
        this.port = port
        return `http://localhost:${port}/auth/callback`
      } catch {
        continue
      }
    }
    throw new Error('Could not find available port for auth callback server')
  }

  private startOnPort(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer(this.handleRequest.bind(this))

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} already in use`))
        } else {
          reject(err)
        }
      })

      this.server.listen(port, 'localhost', () => {
        console.log(`[AuthCallbackServer] Listening on http://localhost:${port}/auth/callback`)
        resolve()
      })
    })
  }

  /**
   * Wait for the auth callback with tokens
   */
  waitForCallback(): Promise<AuthCallbackResult> {
    return new Promise((resolve, reject) => {
      this.resolver = resolve
      this.rejecter = reject

      // Timeout after 10 minutes (signup may take a while)
      setTimeout(() => {
        if (this.resolver) {
          this.stop()
          reject(new Error('Auth timeout: No callback received within 10 minutes'))
        }
      }, 10 * 60 * 1000)
    })
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${this.port}`)

    // Handle CORS preflight for any browser-based redirects
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*'
      })
      res.end()
      return
    }

    if (url.pathname === '/auth/callback') {
      const accessToken = url.searchParams.get('access_token')
      const refreshToken = url.searchParams.get('refresh_token')
      const error = url.searchParams.get('error')
      const errorDescription = url.searchParams.get('error_description')

      if (error) {
        this.sendErrorPage(res, error, errorDescription)
        if (this.rejecter) {
          this.rejecter(new Error(`Auth error: ${error} - ${errorDescription}`))
          this.rejecter = null
          this.resolver = null
        }
        this.stop()
        return
      }

      if (!accessToken || !refreshToken) {
        this.sendErrorPage(res, 'invalid_request', 'Missing access_token or refresh_token')
        if (this.rejecter) {
          this.rejecter(new Error('Auth callback missing required token parameters'))
          this.rejecter = null
          this.resolver = null
        }
        this.stop()
        return
      }

      // Success
      this.sendSuccessPage(res)

      if (this.resolver) {
        this.resolver({ access_token: accessToken, refresh_token: refreshToken })
        this.resolver = null
        this.rejecter = null
      }

      setTimeout(() => this.stop(), 1000)
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    }
  }

  private sendSuccessPage(res: ServerResponse): void {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Connected to 20x</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
            }
            .container {
              text-align: center;
              background: rgba(255, 255, 255, 0.1);
              padding: 3rem;
              border-radius: 1rem;
              backdrop-filter: blur(10px);
            }
            .icon { font-size: 4rem; margin-bottom: 1rem; }
            h1 { margin: 0 0 0.5rem 0; font-size: 2rem; }
            p { margin: 0; opacity: 0.9; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="icon">\u2713</div>
            <h1>Connected!</h1>
            <p>You can close this window and return to the 20x app.</p>
          </div>
        </body>
      </html>
    `
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  }

  private sendErrorPage(res: ServerResponse, error: string, description: string | null): void {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Connection Failed</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
              color: white;
            }
            .container {
              text-align: center;
              background: rgba(255, 255, 255, 0.1);
              padding: 3rem;
              border-radius: 1rem;
              backdrop-filter: blur(10px);
              max-width: 500px;
            }
            .icon { font-size: 4rem; margin-bottom: 1rem; }
            h1 { margin: 0 0 0.5rem 0; font-size: 2rem; }
            p { margin: 0.5rem 0 0 0; opacity: 0.9; }
            .error-details {
              margin-top: 1rem;
              padding: 1rem;
              background: rgba(0, 0, 0, 0.2);
              border-radius: 0.5rem;
              font-size: 0.875rem;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="icon">\u2717</div>
            <h1>Connection Failed</h1>
            <p>There was a problem connecting to 20x Cloud.</p>
            <div class="error-details">
              <strong>Error:</strong> ${error}<br>
              ${description ? `<strong>Details:</strong> ${description}` : ''}
            </div>
            <p style="margin-top: 1.5rem;">Please close this window and try again.</p>
          </div>
        </body>
      </html>
    `
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  }

  stop(): void {
    if (this.server) {
      this.server.close(() => {
        console.log('[AuthCallbackServer] Server stopped')
      })
      this.server = null
    }
    this.resolver = null
    this.rejecter = null
  }

  getRedirectUri(): string {
    return `http://localhost:${this.port}/auth/callback`
  }
}
