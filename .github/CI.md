# CI

GitHub Actions runs two workflows. The `check` job of `ci.yml` is the one every PR must pass.

| Workflow | When | What |
|---|---|---|
| [`ci.yml`](workflows/ci.yml), job **`check`** | every pull request (any base branch, so stacked PRs are covered) and every push to `main` | install → lint → typecheck → fetch uWebSockets.js for Linux and check it loads → `pnpm test` → tests of the CI scripts → `pnpm build` → job summary |
| [`wt-gateway.yml`](workflows/wt-gateway.yml) | only when `apps/wt-gateway/**` or the workflow changes | `cargo build --locked --release` and `cargo test --locked --release` for the Rust WebTransport gateway (the tests reuse the release build's dependencies, so debug assertions are off in CI). Does nothing while the gateway is not in the tree |

## What `check` does

- **Install:** Node 22, pnpm from `package.json` `packageManager`, and `pnpm install --frozen-lockfile`. The pnpm store is cached on `pnpm-lock.yaml`.
- **Lint, typecheck, test:** the same `pnpm lint`, `pnpm typecheck` and `pnpm test` you run locally. Typecheck and test still run when lint fails, and turbo's `--continue` runs every package even when one fails, so one run reports every failure. Tests run with `--force`, so every package writes a fresh report. Failing tests become annotations on the PR diff.
- **uWebSockets.js:** `pnpm uws:fetch` downloads the Linux binary for the runner's Node ABI (cached on that ABI and `scripts/fetch-uws.mjs`). The step then fails if `loadUws()` cannot load it. `apps/game-server/test/server.test.ts` runs the pipe tests on every transport that loads, so without this check a broken download would quietly test ws only.
- **Build:** `pnpm build` (turbo `build`, which runs `vite build` for apps/web). Typecheck and vitest both accept an import of an asset that does not exist (vite types `*?url` as `string`, and vitest resolves it to a `/@fs/` path), so only the production build catches a dangling asset import or a missing build input.
- **Job summary:** [`scripts/test-summary.mjs`](scripts/test-summary.mjs) turns each package's vitest JSON report into one table. It shows counts per package and in total, golden replays (`packages/sim/test/golden.test.ts`), the server pipe per transport (tests named `(uws)` / `(ws)`), the failures, and a per-file table. A missing report, or a highlight with no tests, becomes a warning.
- A new push to a PR cancels that PR's run in progress. Runs on `main` always finish. The job times out after 15 minutes.

## Rules for packages

- **A workspace `test` script must be `vitest run`** (flags are fine). CI appends `--reporter=default --reporter=github-actions --reporter=json --outputFile.json=.turbo/vitest-report.json` through turbo, and other runners would reject those flags.
- A new package with a `test` script needs no workflow change. It shows up as its own row in the summary.
- `typecheck` and `test` depend on turbo's no-op `transit` task (`turbo.json`). Their cache key therefore covers every workspace dependency, and a change in `packages/shared` invalidates the results of sim, server and web. Don't add `^typecheck` / `^test`: they would serialise the run for nothing.
- Turbo only hashes files inside a package. `tsconfig.base.json` sits at the root, so it is listed in `globalDependencies` in `turbo.json`, and editing it invalidates every cached result. If a package's tsconfig starts extending another file outside the package, add that file there too. `.github/scripts/turbo-inputs.test.mjs` fails until you do.

## Run it locally

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm uws:fetch && pnpm test && pnpm build
node --test ".github/scripts/*.test.mjs"
# the job summary, printed to the terminal:
pnpm test --force -- --reporter=default --reporter=json --outputFile.json=.turbo/vitest-report.json
node .github/scripts/test-summary.mjs
```

In a worktree, add `--force` to `typecheck` and `test`. The turbo cache is shared with the other worktrees, and it does not hash gitignored inputs such as the uWS binary in `apps/game-server/vendor/`. CI starts with an empty cache, so it never replays a result.

## Cost

The repo is private, so runs use the account's free Actions minutes (GitHub Free: 2,000 a month on Linux runners). A `check` run should take about 2 minutes. That is an estimate from local timings of the same steps, not yet measured on a runner. `wt-gateway` takes a few minutes, but only when the gateway changes, and its cargo cache keeps rebuilds short. Watch usage in the account's billing settings while eight workstreams push. Cancelling superseded PR runs is the main saving.

## Branch protection (suggested, not applied)

These settings are for `main`. Changing them is the user's call.

- Require a pull request before merging.
- Require the status check **`check`**, with "Require branches to be up to date before merging" turned on.
- Block force pushes and deletion.
- Do **not** require `cargo build + test` (wt-gateway). It is path-filtered, so PRs that don't touch the gateway would wait for it forever.

On a private repo, GitHub Free does not offer branch protection or rulesets: the API answers "Upgrade to GitHub Pro or make this repository public". Until the plan changes, the rule is simply to merge only when `check` is green. Once it is available, the settings above can be applied in Settings → Rules → Rulesets.

## Updating actions

Actions are pinned to full commit SHAs, with the release as a comment (`uses: actions/checkout@<sha> # v7.0.1`), so a moved tag cannot change what runs. To update one, find the new release's commit with `gh api repos/<owner>/<action>/commits/<tag> --jq .sha`, and replace the SHA and the comment together.
