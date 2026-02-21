# Contributing to 20x

Thanks for your interest in contributing! Here's how to get started.

## Prerequisites

- **Node.js** >= 22
- **pnpm** >= 9
- **Git**

## Dev Setup

```bash
git clone https://github.com/peakflo/20x.git
cd 20x
pnpm install
pnpm dev
```

## Project Structure

```
src/
  main/           # Electron main process (SQLite, agents, IPC)
  preload/        # Context bridge
  renderer/       # React UI (Zustand, Tailwind CSS, Radix UI)
  shared/         # Shared constants and types
```

## Code Style

- TypeScript strict mode
- CSS variable tokens (no hardcoded color classes)
- Use `pnpm` (not npm)
- Minimal Tailwind classes

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation only
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `test:` — adding or updating tests
- `chore:` — maintenance tasks

## Pull Request Process

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `pnpm typecheck && pnpm build && pnpm test:run`
4. Open a PR with a clear description of what changed and why
5. Wait for review — at least one approval required

## Testing

```bash
pnpm test          # Watch mode
pnpm test:run      # Single run
pnpm test:main     # Main process tests only
pnpm test:renderer # Renderer tests only
```

## Questions?

Open a [GitHub Discussion](https://github.com/peakflo/20x/discussions) or join our [Discord](https://discord.gg/bPgkmycM).
