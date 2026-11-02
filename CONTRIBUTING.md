# Contributing to BAX Print Suite

Thanks for helping build an open print production platform. This guide covers how to contribute and the rules every contribution has to follow.

## Ground rules: clean-room contributions
This project is an independent implementation built from **public standards, public documentation, and our own design**. To keep it legally clean for everyone who uses it:

**Do not contribute:**
- Code, assets, strings, or UI copied from any proprietary RIP, driver, or vendor product.
- Material from decompiling, disassembling, or reverse-engineering proprietary software or firmware, or from bypassing license or copy protection.
- Documents, specs, or SDK files you received under an NDA or a restricted partner program, or anything derived from them.
- Vendor SDK binaries, headers, credentials, API keys, or licensed ICC profiles and color libraries.

**Do:** cite the public sources you used (standards, papers, public docs) in your PR description. If you're unsure whether something is OK, open a discussion **before** writing code.

Integrations that need a proprietary SDK belong in a separate plugin repository (see [ADR-0005](docs/adr/0005-proprietary-sdk-plugins-separate-repos.md)).

The observation, spec, and differential-test procedure is in [docs/research/clean-room-method.md](docs/research/clean-room-method.md).

## Developer Certificate of Origin
We use the [Developer Certificate of Origin 1.1](https://developercertificate.org/) instead of a CLA. Every commit must carry a sign-off line:

```
Signed-off-by: Jane Doe <jane@example.com>
```

Add it with `git commit -s`. A DCO check runs on every pull request. By signing off, you certify that you have the right to submit the work under the project's license, Apache-2.0.

### AI-assisted contributions
AI tools are allowed. You are responsible for what you submit: review it, make sure it doesn't reproduce third-party code under incompatible terms, and note significant AI assistance in the PR description.

## Workflow
1. Open or find an issue. For larger changes, agree on the design first (big ones get an ADR under `docs/adr/`).
2. Fork the repo or create a branch: `feat/<short-name>`, `fix/<short-name>`, `docs/<short-name>`.
3. Make focused commits using [Conventional Commits](https://www.conventionalcommits.org/): `feat(queue): add priority aging`, `fix(hotfolder): ignore temp files`.
4. Open a pull request against `main` and fill in the template.
5. CI must pass: build, lint, tests on Windows and Linux, the license check, and the DCO check. At least one maintainer approval is required. We squash-merge.

## Development
- Node.js 22 LTS, pnpm 9+.
- `pnpm install`, `pnpm build`, `pnpm test`, `pnpm lint`.
- Tests: Vitest. New behavior needs tests. Plugin interface changes need protocol conformance tests.

## Dependencies
New dependencies must follow [docs/LICENSING.md](docs/LICENSING.md). CI fails on licenses that aren't on the allowlist.

## Reporting security issues
Don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
