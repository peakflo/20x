import { execFile, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { shell } from 'electron'

const execFileAsync = promisify(execFile)

export interface GlabCliStatus {
  installed: boolean
  authenticated: boolean
  username?: string
}

export class GitLabManager {
  private authProcess: ChildProcess | null = null

  async checkGlabCli(): Promise<GlabCliStatus> {
    try {
      await execFileAsync('glab', ['--version'])
    } catch {
      return { installed: false, authenticated: false }
    }

    try {
      const { stdout } = await execFileAsync('glab', ['auth', 'status'])
      // glab auth status outputs "Logged in to <hostname> as <username>"
      const match = stdout.match(/Logged in to .+ as (\S+)/) ||
                    stdout.match(/as (\S+)/)
      return { installed: true, authenticated: true, username: match?.[1] }
    } catch (error: unknown) {
      const execErr = error as { stderr?: string; stdout?: string }
      const output = (execErr?.stderr || '') + (execErr?.stdout || '')
      if (output.includes('Logged in')) {
        const match = output.match(/as (\S+)/)
        return { installed: true, authenticated: true, username: match?.[1] }
      }
      return { installed: true, authenticated: false }
    }
  }

  async startWebAuth(onDeviceCode?: (code: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.authProcess = spawn(
        'glab',
        ['auth', 'login', '--hostname', 'gitlab.com'],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      )

      let completed = false
      let browserOpened = false
      let output = ''
      const timeout = setTimeout(() => {
        if (!completed) {
          this.authProcess?.kill()
          reject(new Error('Auth timeout'))
        }
      }, 120000)

      const handleOutput = (data: Buffer): void => {
        output += data.toString()

        // glab uses a web-based flow similar to gh
        if (onDeviceCode) {
          const codeMatch = output.match(/code:\s*([A-Z0-9-]+)/)
          if (codeMatch) {
            onDeviceCode(codeMatch[1])
          }
        }

        if (!browserOpened) {
          const urlMatch = output.match(/(https:\/\/gitlab\.com\/\S+)/)
          if (urlMatch) {
            browserOpened = true
            shell.openExternal(urlMatch[1])
          }
        }
      }

      this.authProcess.stderr?.on('data', handleOutput)
      this.authProcess.stdout?.on('data', handleOutput)

      this.authProcess.on('close', (code) => {
        completed = true
        clearTimeout(timeout)
        this.authProcess = null
        if (code === 0) resolve()
        else reject(new Error(`glab auth login exited with code ${code}`))
      })

      this.authProcess.on('error', (err) => {
        completed = true
        clearTimeout(timeout)
        this.authProcess = null
        reject(err)
      })

      // Write newline for any potential prompts
      this.authProcess.stdin?.write('\n')
    })
  }
}
