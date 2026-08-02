# Model catalog runtime invalidation follow-up

Status: In progress

## Upstream lineage and branch policy

- Problem: [issue #8697](https://github.com/diegosouzapw/OmniRoute/issues/8697).
- Required foundation: [PR #8728](https://github.com/diegosouzapw/OmniRoute/pull/8728), current head
  `69d6e59ef9aa2fad376795ff71a458dfee392c49`.
- Working branch: `fix/model-catalog-runtime-invalidation` in an isolated worktree.
- Baseline: exact PR #8728 head. The deployed integration branch and its untracked `.pi/` and
  `PLAN/` content remain untouched.
- Delivery order: after implementation, tests, and independent review, push this focused source
  branch to `xz-dev/OmniRoute` without opening an upstream PR. Integrate it into a downstream
  deployment candidate, safely deploy to the active server, and measure production Primary and
  Supplemental model-list behavior. Open the upstream follow-up only if production evidence shows
  an actual improvement. Before opening it, rebase/reapply onto the then-active upstream
  `release/vX.Y.Z` tip and reference #8697 and #8728.
- Preserve contributor lineage: do not close, replace, or silently supersede #8728.

## Diagnosed production behavior

1. The Pi extension starts these mandatory requests concurrently:
   - primary `GET /v1/models?prefix=alias`;
   - supplemental `GET /api/v1/vscode/_/models`.
2. Their model-catalog cache keys differ because the key includes `prefix`; the primary key uses
   `alias`, while supplemental normally has an empty prefix.
3. Both can therefore execute the full unified catalog builder independently on the single Node
   request process.
4. Ordinary chat activity updates provider-connection runtime state such as `lastUsedAt` and
   `consecutiveUseCount` through `updateProviderConnection()`.
5. `updateProviderConnection()` always calls `invalidateDbCache("connections")`, which advances
   `modelCatalogCacheVersion`; #8728 then correctly hard-invalidates all published snapshots.
6. This turns otherwise cacheable requests back into cold builds. Production observation showed a
   cold model GET around 12–15 seconds, an immediate same-key cache hit around 1.2 seconds, and a
   concurrent cheap HEAD probe blocked for the same cold-build interval.
7. Production has no OpenRouter connection, so the conditional 15-second OpenRouter refresh is not
   the cause of this deployment's repeated latency.

## Actor, need, and value

- Actor: API clients that discover OmniRoute models, including the OmniRoute Pi extension.
- Need: runtime-only provider connection bookkeeping must not discard an already published model
  catalog when it cannot change listed model data or visibility.
- Value: ordinary inference traffic no longer turns the next discovery call into one or two
  process-blocking cold catalog builds.

## First PR scope

### In scope

- Define a conservative boundary between provider-connection writes that can affect the unified
  model catalog and runtime-only writes that cannot.
- Add a narrow persistence API or update mode for proven runtime-only patches.
- Migrate only source-proven hot runtime call sites in the first slice.
- Preserve ordinary connection read-cache invalidation where updated runtime state must be visible.
- Preserve #8728 successful-snapshot, generation, single-flight, refresh-failure, and hard-
  invalidation semantics.
- Add focused regression tests at the public catalog-response seam.

### Out of scope

- Immutable persisted base-catalog snapshots.
- Moving the full catalog build off the main Node event loop.
- Aligning the Pi extension supplemental prefix or changing that separate repository.
- Caching the final VS Code-transformed response.
- Broad cold-builder optimization, N+1 removal, or auto-combo redesign.
- Opening an upstream PR before downstream production evidence demonstrates improvement.

## Agreed acceptance examples

The stable public seam is `getUnifiedModelsResponse()` plus the public provider-connection
persistence operation that caused the state transition. Builder-run count is supporting diagnostic
evidence; the externally meaningful result is whether the next identical model-list request must
await/materialize a new catalog.

### A1 — affinity bookkeeping preserves the published catalog

Given:

- a provider connection exists;
- an authenticated `GET /v1/models?prefix=alias` has successfully published a catalog snapshot;
- the same connection receives an affinity bookkeeping update containing only `lastUsedAt` and
  `consecutiveUseCount`.

When the same model-list request is made again,

Then:

- the updated connection runtime fields are observable through the provider persistence API;
- the existing model catalog remains usable;
- no second full catalog-builder execution is required.

### A2 — catalog-affecting connection changes still hard-invalidate

Given the same successfully published snapshot,

When the connection is changed in a way that affects listed-model visibility or eligibility (use a
source-proven field such as `isActive` or `excludedModels`),

Then the next identical model-list request performs a current-generation rebuild and reflects the
new catalog-affecting state.

### A3 — unrelated runtime fields are not guessed safe

Any provider-connection field whose catalog impact is ambiguous remains on the existing hard-
invalidation path until source analysis and a separate acceptance example prove otherwise.

## Implementation slices

- [x] S0 — reproduce production latency and trace both request paths.
- [x] S1 — confirm #8703, #8833, and deployed #8728 behavior is already present.
- [x] S2 — create isolated follow-up branch from exact #8728 head and record this plan.
- [x] S3 — complete source-backed field/call-site classification.
- [x] S4 — add focused RED for A1 and retain GREEN control for A2.
- [x] S5 — implement the smallest safe invalidation split and migrate only proven hot call sites.
- [x] S6 — prove test sensitivity with an intentional break, then restore GREEN.
- [x] S7 — format, focused tests, overlap tests, lint, typecheck, diff checks.
- [x] S8 — independent reviewer approval; resolve findings and re-review.
- [ ] S9 — commit and push the focused source branch to `xz-dev/OmniRoute`; do not open an upstream
      PR yet.
- [ ] S10 — integrate the source branch into an isolated downstream deployment candidate, build an
      immutable image, smoke-test it against isolated production-shaped state, retain rollback state,
      then deploy OmniRoute and recreate Tailscale according to server policy.
- [ ] S11 — measure production Primary and Supplemental requests concurrently and sequentially,
      compare cold/cache-hit behavior and cheap HEAD event-loop probes against the recorded baseline,
      and verify service health/logs.
- [ ] S12 — only if the evidence shows a material improvement, rebase/reapply onto the active
      upstream release tip, rerun all checks/review, and ask for final authorization before opening the
      upstream follow-up PR referencing #8697 and #8728.

## Planned verification

- Focused runtime-invalidation regression test.
- Existing #6408 concurrent/fresh-cache tests.
- Existing #8728 cache, policy-invalidation, source-invalidation, and response-flush suites.
- Provider CRUD and session-affinity tests covering migrated persistence paths.
- Intentional-break proof that A1 fails when runtime-only updates use the hard-invalidation path.
- Prettier on changed files, targeted ESLint, `npm run typecheck:core`, and `git diff --check`.
- A production-shaped isolated TCP test only if it can run without production credentials, shared
  state, or deployment side effects.

## Safety and evidence rules

- Never log or persist API keys, connection credentials, model bodies, request prompts, or raw
  provider errors in performance evidence.
- Do not stop/restart/reconfigure production during implementation.
- Do not weaken hard invalidation for fields merely because they appear operational; prove they
  cannot affect catalog output first.
- Keep the first PR small. The asynchronously published immutable base-catalog design remains a
  separate follow-up after this root-cause slice.
