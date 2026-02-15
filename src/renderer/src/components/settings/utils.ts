// Shell argument helpers
export function shellQuoteArg(arg: string): string {
  return arg.includes(' ') ? `"${arg}"` : arg
}

export function parseShellArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inDouble = false
  let inSingle = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === ' ' && !inDouble && !inSingle) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }

  if (current) args.push(current)
  return args
}

// Note: testMcpConnection is imported from useMcpStore().testConnection
// This is just a re-export type for convenience
export type TestMcpConnectionFn = (testData: {
  id: string
  name: string
  type: 'local' | 'remote'
  command?: string
  args?: string[]
  environment?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}) => Promise<{ status: 'connected' | 'failed'; error?: string; toolCount?: number }>
