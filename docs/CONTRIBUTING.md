# Contributing

Use [Discussions](https://github.com/solarcloud7/clusterio-surface-export/discussions) for questions and design proposals, and [Issues](https://github.com/solarcloud7/clusterio-surface-export/issues/new/choose) for actionable bugs and features. Small, focused pull requests are welcome.

For local setup, follow the [development guide](../docker/README.md). Use a branch and keep generated artifacts and credentials out of commits.

Run checks from the repository root:

```powershell
npm test
./tools/clusterio/build-plugin.ps1 lint -OutputDirectory ci-artifacts/contributor-check
./tools/clusterio/build-plugin.ps1 test -OutputDirectory ci-artifacts/contributor-check
```

Run these commands sequentially. Build output stays isolated from the development runtime. Live tests can modify worlds; the [test guide](../tests/README.md) identifies their prerequisites and the disposable Docker fixtures.

Describe the problem, resulting behavior, verification and remaining limits in the PR. For cargo, identity or recovery changes, follow the [data-integrity checklist](../.agents/skills/di-change/SKILL.md): preserve the original failure, compare physical cargo independently, and test ambiguous or repeated replies. A green validator alone does not establish conservation.

Keep documentation factual. CI checks executable behavior; do not add tests that parse documentation. Required checks and reviews are shown on each PR. Resolve review findings before merging, and verify the merged revision's CI.

Report vulnerabilities through the [security procedure](SECURITY.md).
