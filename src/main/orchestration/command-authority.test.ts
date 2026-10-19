import { describe, it, expect } from 'vitest'
import { classifyCommandAuthority } from './command-authority'

describe('classifyCommandAuthority — dangerous commands always require a human', () => {
  const dangerous: Array<[string, string]> = [
    ['git push --force origin main', 'git-force-or-destructive'],
    ['rm -rf ~/project', 'destructive-filesystem'],
    ['kubectl apply -f k8s/prod.yaml', 'infra-apply-or-destroy'],
    ['gh pr merge 650 --admin', 'merge-or-release'],
    ['curl -X POST https://api.stripe.com/v1/charges', 'external-http-mutation'],
    ['terraform destroy', 'infra-apply-or-destroy'],
    ['npm publish', 'package-publish']
  ]

  for (const [command, expectedCategory] of dangerous) {
    it(`"${command}" requires a human`, () => {
      const result = classifyCommandAuthority({ toolName: 'exec', command })
      expect(result.requiresHuman).toBe(true)
      expect(result.categories).toContain(expectedCategory)
    })
  }

  it('a bare git push (no force) still requires a human — any git push mutates a remote', () => {
    const result = classifyCommandAuthority({ toolName: 'exec', command: 'git push origin feature-branch' })
    expect(result.requiresHuman).toBe(true)
  })

  it('an unrecognized command defaults to requiring a human (default-deny), not just known-dangerous ones', () => {
    const result = classifyCommandAuthority({ toolName: 'exec', command: 'some-totally-unknown-binary --do-a-thing' })
    expect(result.requiresHuman).toBe(true)
    expect(result.categories).toContain('unrecognized-command')
  })

  it('a destructive database command requires a human', () => {
    const result = classifyCommandAuthority({ toolName: 'exec', command: 'psql -c "DROP TABLE users"' })
    expect(result.requiresHuman).toBe(true)
  })

  it('npm/cargo/docker publish variants all require a human', () => {
    for (const command of ['yarn publish', 'pnpm publish', 'cargo publish', 'docker push myorg/app:latest', 'twine upload dist/*']) {
      expect(classifyCommandAuthority({ toolName: 'exec', command }).requiresHuman).toBe(true)
    }
  })
})

describe('classifyCommandAuthority — the small safe allowlist', () => {
  const safe = [
    'ls -la',
    'cat README.md',
    'grep -rn "TODO" src',
    'git status',
    'git diff',
    'git log --oneline -5',
    'git add .',
    'git commit -m "fix"',
    'npm install',
    'npm ci',
    'npm test',
    'npm run build',
    'npm run lint',
    'npm run typecheck',
    'pytest tests/',
    'cargo test',
    'make test'
  ]

  for (const command of safe) {
    it(`"${command}" does not require a human`, () => {
      const result = classifyCommandAuthority({ toolName: 'exec', command })
      expect(result.requiresHuman).toBe(false)
    })
  }

  it('a recognized file-edit tool inside the workspace does not require a human', () => {
    const result = classifyCommandAuthority({
      toolName: 'edit',
      command: 'src/main/index.ts',
      workspaceDir: '/workspace'
    })
    expect(result.requiresHuman).toBe(false)
  })

  it('a file-edit tool writing outside the workspace requires a human', () => {
    const result = classifyCommandAuthority({
      toolName: 'edit',
      command: 'Edit /workspace/../etc/passwd',
      workspaceDir: '/workspace'
    })
    expect(result.requiresHuman).toBe(true)
    expect(result.categories).toContain('file-write-outside-workspace')
  })

  it('a file-edit tool targeting an absolute path outside the given workspace dir requires a human', () => {
    const result = classifyCommandAuthority({
      toolName: 'write',
      command: 'Write to /Users/someone/.ssh/authorized_keys',
      workspaceDir: '/workspace'
    })
    expect(result.requiresHuman).toBe(true)
  })

  it('a home-directory shorthand path always requires a human, even without a workspaceDir', () => {
    const result = classifyCommandAuthority({ toolName: 'edit', command: 'edit ~/.bashrc' })
    expect(result.requiresHuman).toBe(true)
  })
})

describe('classifyCommandAuthority — no command/tool at all', () => {
  it('falls back to safe (false) when there is nothing to classify — callers combine this with the prose-based gate for questionText', () => {
    const result = classifyCommandAuthority({})
    expect(result.requiresHuman).toBe(false)
    expect(result.categories).toEqual([])
  })
})
