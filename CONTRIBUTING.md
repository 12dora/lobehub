# Contributing to LobeHub Enhanced

Thanks for helping out! This repository is a community fork of
[lobehub/lobehub](https://github.com/lobehub/lobehub) that adds an enterprise admin console and
platform governance. Contributions are welcome as pull requests against `main`.

## Where a change belongs

- **Fork-specific behaviour** (admin console, platform RBAC, managed resources, audit, identity
  providers, branding, ChatGPT Web provider) — send it here.
- **Upstream behaviour** that is not part of the enterprise additions — please send it to
  [lobehub/lobehub](https://github.com/lobehub/lobehub) first. We pick up upstream changes by
  explicit, reviewed merges rather than an automatic sync.

## Workflow

```bash
git clone https://github.com/12dora/lobehub-enhanced.git
cd lobehub-enhanced
pnpm install
```

1. Branch off `main` using `<type>/<short-name>` (e.g. `feat/admin-usage-export`).

2. Make your change. Read [`AGENTS.md`](./AGENTS.md) for the tech stack and code conventions, and
   [`DESIGN.md`](./DESIGN.md) for the product design values that user-facing flows must follow.

3. Add tests wherever the surrounding code has them, and localise every user-facing string
   (`packages/locales/src/default/`, mirrored to `locales/en-US` and `locales/zh-CN`).

4. Run the checks on the files you touched:

   ```bash
   bun run check <changed files>   # lint + related tests
   bun run check --type            # full type check
   ```

5. Commit with a gitmoji prefix and a clear message, then open a pull request against `main`
   describing what changed and how you verified it.

## Reporting problems

Open an [issue](https://github.com/12dora/lobehub-enhanced/issues) for bugs and feature requests.
For security problems, follow [`SECURITY.md`](./SECURITY.md) instead — never a public issue.

## Licence

By contributing you agree that your contribution is licensed under the terms in
[`LICENSE`](./LICENSE) (the LobeHub Community License).
