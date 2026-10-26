# CLAUDE.md

Read AGENTS.md first.

- The root holds only README, LICENSE, CONTRIBUTING, CHANGELOG, SECURITY, AGENTS.md, CLAUDE.md and config files. Everything else lives under `apps/`, `packages/`, `examples/`, `docs/` or `scripts/`.
- No scratch folders, generated output, local data or `.env` files in git.
- Every package has its own README and LICENSE. Licenses follow `docs/adr/0004-license-split.md`.
- Write the failing test first. Conventional commits. CI must pass before merge.
- Write commit messages, PR descriptions, comments and docs for outside readers: say what changed and why. Comments explain why non-obvious code works as it does, not how it came to be written.
- Mark a deliberate simplification with a `shortcut:` comment that names its limit and the upgrade path, for example `// shortcut: one source, so no source interface; extract one when a second source lands`.
- Record significant technical decisions as a new dated ADR in `docs/adr/`.
- Public docs state what the project does, with no comparisons to other projects.
- Never commit secrets. `.env.example` keeps empty values.
