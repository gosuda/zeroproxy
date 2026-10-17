# Agent Rules

Project onboarding, architecture, and build/test instructions live in [CLAUDE.md](CLAUDE.md). The rules below apply to every task.

## Code quality

- Always follow the `deslop` skill (`.agents/skills/deslop/SKILL.md`): no AI-generated slop in tests, production code, comments, or docs.
- Always follow the best-practices skills that match the work (`just-good-practices`, `code-health`, `testing-practices`, `api-design`, and the language-specific ones such as `go-practices`, `cpp-practices`, `shell-practices`). Read the matching skill before you start.
- Write all code, comments, log/error strings, test names, assertion messages, and documentation in English only. Do not include Korean text in source files or documentation.

## Documentation

- Do not keep a change log in the form of a diary. Do not record what you did, when, or in which session. Git history holds that.
- Write documents that describe the current state (what is true now, and why), not the path taken to get there. Do not narrate attempts, detours, or dead ends.
- When the state changes, rewrite the affected text so it is true again. Do not append a dated entry next to the stale one.
