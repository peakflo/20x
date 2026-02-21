# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in 20x, **please do not open a public issue.**

Instead, report it privately:

- **Email:** [support@peakflo.co](mailto:support@peakflo.co)
- **GitHub:** Use [GitHub's private vulnerability reporting](https://github.com/peakflo/20x/security/advisories/new)

We'll acknowledge your report within 48 hours and provide a timeline for a fix.

## Scope

The following are in scope:

- Electron security issues (context isolation bypass, IPC vulnerabilities)
- SQLite injection or data leakage
- OAuth token exposure or mishandling
- API key leakage
- Remote code execution via agent sessions
- Privilege escalation

Out of scope:

- Social engineering attacks
- Vulnerabilities in third-party dependencies (report these upstream)
- Issues requiring physical access to the user's machine

## Disclosure

We follow coordinated disclosure. We'll work with you to understand and fix the issue before any public disclosure.
