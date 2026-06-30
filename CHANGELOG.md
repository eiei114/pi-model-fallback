# Changelog

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
