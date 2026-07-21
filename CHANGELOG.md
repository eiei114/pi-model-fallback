# Changelog

## Unreleased

### Fixed

- Document the missing `git add`/`git commit` steps in `CONTRIBUTING.md` release instructions so maintainers can trigger auto-release after `npm version patch --no-git-tag-version`.
- Clarify that maintainers should update `CHANGELOG.md` before staging release files.

### Changed

- Bump package version to `0.3.4` for the next patch release.

- Declare `@earendil-works/pi-agent-core` as a peerDependency to align with pi-extension-template.
- Add Buy Me a Coffee sponsor button to README and native GitHub funding link via `.github/FUNDING.yml`.

## [0.3.3] - 2026-07-04

### Changed

- Rewrite the README with real `pi-model-fallback` install, command, configuration, and state-path documentation instead of template placeholders.

## [0.3.2] - 2026-07-04

### Fixed

- Publish only from release refs, print Node/npm versions, and publish with `--provenance --access public` so npm Trusted Publishing uses the same known-good path as `pi-spotify-widget`.
- Release instructions now use `npm version patch --no-git-tag-version` so local tags do not race the auto-release workflow.

## 0.3.0

- Use `agent_start` for persistent preselect; `session_start` was not a Pi extension event.
- Persist fallback state from assistant error messages on `turn_end`, covering provider SDK errors that do not emit `after_provider_response`.

## 0.2.0

- Add persistent failover state. A matching provider failure now writes `model-fallback/state.json`, and future sessions preselect the fallback model before the first provider call until the cooldown expires.
- Parse retry/reset headers when available; otherwise default 429 cooldown to 72h and 5xx cooldown to 10m.
- `/model-fallback:reset` now clears persistent state.

All notable changes to this project will be documented in this file.

This project follows semantic versioning.

## [0.1.3] - 2026-06-19

### Changed

- CONTRIBUTING now reminds maintainers to run `npm pack --dry-run` after changing which `docs/` files ship in the package.

### Fixed

- README License section no longer ends with a literal `\n` placeholder.

## [0.1.2] - 2026-06-04

### Changed

- README and `docs/template-checklist.md` now follow the Pi OSS minimal-docs policy: `docs/` is optional, with explicit post-generation cleanup for template bootstrap docs.
- Template bootstrap docs (`github-template.md`, `repository-settings.md`, `typescript.md`) are labeled for delete-or-merge after setup.

## [0.1.1] - 2026-06-01

### Changed

- Publish workflow now supports npm publishing on merged package version bumps in addition to tags, releases, and manual dispatch.
- Publish workflow now installs a current npm CLI so npm Trusted Publishing OIDC is supported.
- CI and publish workflow commands no longer include literal trailing `\\n` text.

## [0.1.0] - YYYY-MM-DD

### Added

- Initial Pi package template.
- Example extension, Agent Skill, prompt, and theme.
- CI and npm Trusted Publishing workflow.

