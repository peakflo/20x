/**
 * Auth Callback Server
 *
 * Creates a temporary HTTP server on localhost to receive auth callbacks
 * from workflow-builder after browser-based signup/login.
 *
 * Supabase sends tokens in the URL fragment (#access_token=...&refresh_token=...)
 * which is never sent to the HTTP server. So the flow is:
 *
 *   1. GET /auth/callback  → serves an HTML page with JS that reads the fragment
 *   2. The JS extracts tokens and POSTs them to /auth/receive-tokens
 *   3. POST /auth/receive-tokens → receives tokens, resolves the promise, shows success
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

    // CORS headers for the POST from the same page
    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(200, corsHeaders)
      res.end()
      return
    }

    // Step 1: Serve the token-extraction page
    // Handles both fragment (#) and query param (?) token formats
    if (url.pathname === '/auth/callback' && req.method === 'GET') {
      // Check if tokens are in query params (some flows use ? instead of #)
      const qAccessToken = url.searchParams.get('access_token')
      const qRefreshToken = url.searchParams.get('refresh_token')
      const qError = url.searchParams.get('error')

      if (qError) {
        const desc = url.searchParams.get('error_description')
        this.sendErrorPage(res, qError, desc)
        if (this.rejecter) {
          this.rejecter(new Error(`Auth error: ${qError} - ${desc}`))
          this.rejecter = null
          this.resolver = null
        }
        this.stop()
        return
      }

      if (qAccessToken && qRefreshToken) {
        // Tokens came as query params — resolve directly
        this.sendSuccessPage(res)
        if (this.resolver) {
          this.resolver({ access_token: qAccessToken, refresh_token: qRefreshToken })
          this.resolver = null
          this.rejecter = null
        }
        setTimeout(() => this.stop(), 1000)
        return
      }

      // No query params — tokens are likely in the fragment (#)
      // Serve an HTML page that extracts them client-side and POSTs back
      this.sendTokenExtractorPage(res)
      return
    }

    // Step 2: Receive tokens POSTed from the extractor page
    if (url.pathname === '/auth/receive-tokens' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          const accessToken = data.access_token
          const refreshToken = data.refresh_token

          if (!accessToken || !refreshToken) {
            res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Missing tokens' }))
            return
          }

          res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))

          if (this.resolver) {
            this.resolver({ access_token: accessToken, refresh_token: refreshToken })
            this.resolver = null
            this.rejecter = null
          }

          setTimeout(() => this.stop(), 1000)
        } catch {
          res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid JSON' }))
        }
      })
      return
    }

    // Unknown path
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  }

  /**
   * Serve an HTML page that extracts tokens from the URL fragment (#)
   * and POSTs them back to the server.
   */
  private sendTokenExtractorPage(res: ServerResponse): void {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connecting to 20x...</title>
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
      max-width: 400px;
    }
    .spinner {
      width: 48px; height: 48px;
      border: 4px solid rgba(255,255,255,0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 1.5rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .icon { font-size: 4rem; margin-bottom: 1rem; display: none; }
    h1 { margin: 0 0 0.5rem 0; font-size: 1.5rem; }
    p { margin: 0; opacity: 0.9; font-size: 0.9rem; }
    .error { display: none; margin-top: 1rem; padding: 1rem; background: rgba(0,0,0,0.2); border-radius: 0.5rem; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner" id="spinner"></div>
    <div class="icon" id="successIcon">&#10003;</div>
    <div class="icon" id="errorIcon">&#10007;</div>
    <h1 id="title">Connecting...</h1>
    <p id="message">Completing authentication with the 20x app.</p>
    <div class="error" id="errorDetail"></div>
  </div>
  <script>
    (function() {
      var hash = window.location.hash.substring(1);
      var params = new URLSearchParams(hash);
      var accessToken = params.get('access_token');
      var refreshToken = params.get('refresh_token');
      var error = params.get('error');
      var errorDesc = params.get('error_description');

      var spinner = document.getElementById('spinner');
      var successIcon = document.getElementById('successIcon');
      var errorIcon = document.getElementById('errorIcon');
      var title = document.getElementById('title');
      var message = document.getElementById('message');
      var errorDetail = document.getElementById('errorDetail');

      function showSuccess() {
        spinner.style.display = 'none';
        successIcon.style.display = 'block';
        title.textContent = 'Connected!';
        message.textContent = 'You can close this window and return to the 20x app.';
      }

      function showError(err, detail) {
        spinner.style.display = 'none';
        errorIcon.style.display = 'block';
        document.body.style.background = 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)';
        title.textContent = 'Connection Failed';
        message.textContent = 'There was a problem connecting to 20x Cloud.';
        if (detail) {
          errorDetail.style.display = 'block';
          errorDetail.innerHTML = '<strong>Error:</strong> ' + err + (detail ? '<br><strong>Details:</strong> ' + detail : '');
        }
      }

      if (error) {
        showError(error, errorDesc);
        return;
      }

      if (!accessToken || !refreshToken) {
        showError('missing_tokens', 'No authentication tokens found in the callback URL. Please try again.');
        return;
      }

      fetch('/auth/receive-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: accessToken,
          refresh_token: refreshToken
        })
      })
      .then(function(resp) {
        if (resp.ok) {
          showSuccess();
        } else {
          showError('server_error', 'Failed to send tokens to the 20x app (status ' + resp.status + ').');
        }
      })
      .catch(function(err) {
        showError('network_error', 'Could not reach the 20x app: ' + err.message);
      });
    })();
  </script>
</body>
</html>`
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  }

  private sendSuccessPage(res: ServerResponse): void {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connected to 20x</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; align-items: center; justify-content: center;
      height: 100vh; margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container {
      text-align: center; background: rgba(255,255,255,0.1);
      padding: 3rem; border-radius: 1rem; backdrop-filter: blur(10px);
    }
    .icon { font-size: 4rem; margin-bottom: 1rem; }
    h1 { margin: 0 0 0.5rem 0; font-size: 2rem; }
    p { margin: 0; opacity: 0.9; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">&#10003;</div>
    <h1>Connected!</h1>
    <p>You can close this window and return to the 20x app.</p>
  </div>
</body>
</html>`
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  }

  private sendErrorPage(res: ServerResponse, error: string, description: string | null): void {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connection Failed</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; align-items: center; justify-content: center;
      height: 100vh; margin: 0;
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      color: white;
    }
    .container {
      text-align: center; background: rgba(255,255,255,0.1);
      padding: 3rem; border-radius: 1rem; backdrop-filter: blur(10px);
      max-width: 500px;
    }
    .icon { font-size: 4rem; margin-bottom: 1rem; }
    h1 { margin: 0 0 0.5rem 0; font-size: 2rem; }
    p { margin: 0.5rem 0 0 0; opacity: 0.9; }
    .error-details {
      margin-top: 1rem; padding: 1rem;
      background: rgba(0,0,0,0.2); border-radius: 0.5rem;
      font-size: 0.875rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">&#10007;</div>
    <h1>Connection Failed</h1>
    <p>There was a problem connecting to 20x Cloud.</p>
    <div class="error-details">
      <strong>Error:</strong> ${error}<br>
      ${description ? `<strong>Details:</strong> ${description}` : ''}
    </div>
    <p style="margin-top: 1.5rem;">Please close this window and try again.</p>
  </div>
</body>
</html>`
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
