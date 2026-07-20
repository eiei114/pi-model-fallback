# Contributing

Thanks for helping improve this Pi package.

## Development

```bash
npm install
npm run ci
```

## Local Pi testing

```bash
pi -e .
```

## Pull requests

Before opening a PR:

- Run `npm run ci`
- Update docs when behavior changes
- Update `CHANGELOG.md` for user-facing changes
- Keep package contents small and intentional
- Run `npm pack --dry-run` when you add, remove, or rename `docs/` files so `package.json` `files` matches what you ship

## Release

Releases use npm Trusted Publishing. Do not add `NPM_TOKEN` to GitHub Secrets.

`npm version patch --no-git-tag-version` updates `package.json` locally without creating a tag. Commit and push that bump so the auto-release workflow on `main` can tag and publish.

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): bump pi-model-fallback"
git push
```
