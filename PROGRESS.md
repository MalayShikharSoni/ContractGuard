# Contract Guard — Progress Log

A running record of what has been built, in order, with verification evidence and the
problems hit along the way. Companion docs: [`CONTEXT.md`](CONTEXT.md) (full project
context), [`README.md`](README.md) (overview), [`PLAN.md`](PLAN.md) (problem statement +
PO Q&A).

---

## Status snapshot (as of 2026-11-18)

| Area | Status |
| --- | --- |
| Wire-model engine (parse → validate → resolve → flatten) | ✅ done |
| Diff engine (endpoints, params, request/response field trees) | ✅ done |
| Severity rules (DANGEROUS / WARNING / DEPRECATED / SAFE) | ✅ done |
| Impact engine (consumer usages → affected-by analysis) | ✅ done |
| Publish pipeline (attempt lifecycle, block/refuse/publish) | ✅ done |
| Webhook notifications | ✅ done |
| Persistence (Postgres schema + version/attempt storage) | ✅ done |
| REST API (services, consumers, usages, publish, diff, metrics) | ✅ done |
| UI (Services, Service page, Diff, Impact & Metrics, Consumers) | ✅ done, browser-verified |
| First-boot seed from kit folders | ✅ done |
| Docker packaging (app + Postgres + webhook receiver) | ✅ done |
| Engine tests | ✅ 15/15 passing |
| Policy tests (one per severity-table rule) | ✅ 19/19 passing |
| Pipeline tests (every stage in isolation) | ✅ 28/28 passing |
| API tests (supertest, HTTP + persistence) | ✅ 15/15 passing |
| End-to-end tests (live stack) | ✅ 11/11 passing |
| Docs (README, CONTEXT, PROGRESS) | ✅ done |
| Manual review queue / override approvals | ⛔ intentionally not built (PO: notify, don't approve) |
| Auth / multi-tenancy | ⛔ out of scope for this stage |
| Consumer-usage "last verified" lifecycle | ⏸ deferred (unmatched-usages surfacing covers the gap) |

---

## Build log — 2026-11-18

### Phase 0 — Kit analysis
- Read every kit file: 3 provider services × 4 spec versions, 4 consumer files, webhook
  receiver, kit README/PLAN. Catalogued the planted scenarios:
  - quote-api v2: pure reorganisation (inlined schemas, renamed components `Premium→PremiumDetails`,
    `BreakdownItem→PriceLine`, renamed path param `{id}→{quoteId}`) → must diff clean.
  - quote-api v3: response field rename `amount→value` (readers break), required `region`
    query param on an `x-internal` endpoint, `EXPIRED` added to a response enum.
  - quote-api v4: optional additions `rider.ncbPercent` (request) and `premium.taxes` (response)
    — but because blocked specs never become the baseline, it still carries v3's dangerous
    changes (`region` required param + `amount` removals) and is BLOCKED again.
  - policy-api v2: deprecations with `x-sunset` dates (one already past: `2026-11-01`).
  - policy-api v3: removal of `legacyCode` (read by `payments-svc`) and `holder.phone` (read by nobody).
  - policy-api v4: request enum narrowed (`VEHICLE` removed) + new required `requestedBy`
    (both hit `partner-portal`).
  - claims-api v2: **broken `$ref`** (`ClaimDocumnt` typo) → the fail-safe test.
  - claims-api v3: same change, fixed — must publish clean.
  - claims-api v4: response field `amountApproved` dropped from `required[]` (readers must
    handle absence) + new `202` response.
- Locked design decisions in code comments and later in `CONTEXT.md` §15 (integer≠number,
  response enum widening = WARNING, etc.).

### Phase 1 — Core engine (pure, no I/O)
- `lib/errors.js` — typed `GuardError` carrying a pipeline `stage` (the fail-safe contract).
- `lib/yaml.js` — strict parse stage (empty/malformed/scalar docs all refuse).
- `lib/openapi.js` — validate stage (OpenAPI shape checks) + `$ref` resolver with cycle
  cutting and broken-ref collection (external refs refuse with the ref named).
- `lib/flatten.js` — wire model: resolved refs → field paths (`.`/`[]`), endpoints keyed by
  `METHOD + normalised route`, allOf merged / oneOf-anyOf unioned, `deprecated`/`x-sunset`/
  enums/formats/additionalProperties captured per node, array-root paths (`[].field`).
- `lib/diff.js` — pairing strategies: endpoints by route shape, path params **by position**
  (→ renames are cosmetic), other params by name, fields by wire path; topmost pruning so a
  restructured subtree reports one root-cause change; atomic per-property facts
  (type/requirement/enum/format/deprecation/strictness) with `direction` stamped.
- `lib/rules.js` — `classify()`: one counterfactual per fact family ("can a correct consumer
  of the OLD contract fail against the NEW one?"), direction-aware; `summarise()` for counts.
- `lib/impact.js` — consumer usage matching: method+route attachment, sends↔request /
  reads↔response, required-addition detection (caller doesn't send it or a child),
  subtree matching via ancestor tests, `[].`→plain-path variants, unmatched-usage surfacing.
- `analyse.js` — pipeline orchestrator + `humanSummary()` for webhooks/UI.
- **Wrote `test/engine.test.js` first as the spec**: every planted scenario becomes an
  assertion (verdicts, counts, per-endpoint facts, affected consumers).
- Iterated: test run #1 exposed a design bug (impact results were computed into a separate
  `perChange` array instead of attached to changes) → fixed by attaching `affected` directly
  onto each change; usage attachment had used path-only keys vs method+path keys → fixed
  with shape extraction from the endpoint key; `changeLocation` rendered "path param
  undefined" → fixed with a kind-specific formatter.
- **Result: 15/15 engine tests passing.**

### Phase 2 — Persistence
- `schema.sql` — 6 idempotent tables: `services`, `consumers`, `consumer_usages`
  (UNIQUE consumer+provider+method+path for upserts), `versions` (spec JSON + **stored flat
  model** + changes/counts/impact, UNIQUE service+version), `publish_attempts` (immutable
  changelog: attempt_no, from→to, status PUBLISHED/BLOCKED/ERROR, error_stage/message, raw
  submitted YAML, notified flag), `notifications` (delivery log).
- `db.js` — pg pool, `query()`, `withTx()` transaction helper.

### Phase 3 — Publish pipeline + API
- `services/publish.js` — full attempt lifecycle: analyse → record attempt → publish or
  stop, all in one transaction; duplicate-version refusal; failed analyses recorded as
  `ERROR` attempts with the failing stage; previews share the analysis but record nothing;
  `diffVersions()` reuses stored flats for any-two-version diffs against *current* usages.
- `services/registry.js` — services/consumers/usages CRUD + `metrics()` (totals, severity
  totals, most-affected consumers, per-service table, unmatched usages computed in JS from
  current flats) + notification log.
- `notify.js` — webhook client: never blocks or fails the pipeline; every delivery (or
  failure) recorded in `notifications`.
- `routes.js` + `index.js` — Express 5 app: JSON + raw-YAML body parsing, `/api` router,
  static UI with history fallback, JSON error mapping (HttpError → status, unexpected →
  500 that names itself as a guard failure).

### Phase 4 — Seed
- `seed.js` — first-boot import in the order that makes impact analysis meaningful:
  register each service → publish its first version (no baseline) → register all consumers
  and usages → then publish every remaining version through the **real pipeline**.
- Verified against the live stack: reorganised quote v2 published clean; broken-ref claims
  v2 refused at stage `resolve`; quote v3 BLOCKED (D:3 W:2); policy v3 BLOCKED (D:4);
  policy v4 BLOCKED (D:6); claims v4 published with W:2 — exactly the intended verdicts.

### Phase 5 — UI
- Vanilla SPA (`ui/index.html`, `style.css`, `app.js`), hash routing, no build step.
- Pages: **Services** (cards + register form) · **Service page** (publish box with
  preview/publish and file upload, current endpoints table, version history with per-version
  changelog, full attempts table with verdicts/impact/notified, consumers-of-this-API) ·
  **Diff** (from/to pickers + candidate-spec analyser) · **Impact & Metrics** (stat cards,
  severity bar, most-affected consumers, per-service table, recent attempts, unmatched
  usages, notification log) · **Consumers** (register + declare/edit usages with remove).
- Verified in the in-app browser (all pages rendered, zero console errors).

### Phase 6 — Docker
- `guard/Dockerfile` (node:20-alpine, prod deps only) + `.dockerignore`.
- Rewrote kit `docker-compose.yml`: added `db` (postgres:16-alpine, healthcheck) and
  `guard` services alongside the untouched `webhook-receiver`; guard mounts `specs/` +
  `consumers/` read-only as the seed dir; `WEBHOOK_URL` wired to the receiver.
- **Result: full stack up with a single `docker compose up --build`, seeds itself.**

### Phase 7 — E2E hardening
- Wrote `test/e2e.test.js` (11 tests vs the live server): health, UI served, seeded state,
  public diff, 422 fail-safe with stage, 409 block with current version unchanged, preview
  records nothing, publish→current + duplicate refusal, registration flows, metrics.
- **Bugs found & fixed during E2E/metrics testing:**
  1. `metrics()` SQL referenced a wrong alias (`imp` vs `impact`) → 500; fixed to
     `pa.impact->'consumers'`.
  2. Unmatched-usage lookup keyed the flat map by service id but looked up by slug →
     every usage reported unmatched (10/10); fixed by selecting `s.id AS provider_id`.
  3. SAFE changes listed consumers as "affected" — contradicted the policy that SAFE
     affects nobody; fixed in `computeImpact` (SAFE → empty `affected`, no findings).
  4. `notified` flag was never persisted on attempts; fixed by marking the attempt after a
     successful webhook delivery (success and failure paths).
  5. E2E test spec-surgery produced an invalid YAML (duplicate key / orphaned enum items)
     → the *guard correctly refused it* (fail-safe working as designed); fixed the test's
     replacement block.
- Test-suites made idempotent (unique slugs per run) so they can be re-run safely.
- **Result: 11/11 E2E tests passing** (and 15/15 engine tests still green).

### Phase 8 — Reset & docs
- Removed a temporary debug script; reset the DB (`docker compose down -v`) so the
  delivered state is the pristine seed; re-verified metrics/services against it.
- Wrote `CONTEXT.md` (the complete project context) and `guard/README.md`; restructured the
  kit `README.md` around the built product.
- **This file** (`PROGRESS.md`) started as the ongoing build log.

### Phase 9 — Test-suite restoration
- The source was committed by hand (`8edbb23`) **without** `guard/test/`, so both suites
  went missing from the project even though the docs promised them. Rebuilt them:
  - `test/engine.test.js` — 15 tests, assertions derived from the actual spec contents and
    consumer files: reorganisation fidelity, quote v3/v4 blocks (amount removals + x-internal
    required param + EXPIRED enum widening), policy deprecation sunsets (past and future),
    policy v3 removals and v4 endorsement tightening (partner-portal, payments-svc), claims
    broken-`$ref` fail-safe + v3 clean republish + v4 optionalisation, route-shape consumer
    matching across a param rename, first publish with no baseline, external-ref / parse /
    validate refusals.
  - `test/e2e.test.js` — 11 tests against the live stack (same coverage as before; unique
    slugs per run so the suite is re-runnable).
- Split the npm scripts so the documented contract holds exactly: `npm test` = engine suite
  only (no DB needed), `npm run test:e2e` = live-stack suite, `npm run test:all` = both.
- Repaired an accidental corruption of an import line in `guard/src/lib/diff.js`
  (`sameOrclassifyAncestor` → `sameOrAncestor`) that had slipped into the working tree
  after the commit — the committed source was already correct.
- **Result: 15/15 engine + 11/11 E2E passing; DB reset to the pristine seed afterwards.**

### Phase 10 — Rule-for-rule and stage-by-stage test coverage (+ supertest)
- Added three suites, without adding any product feature:
  - `test/policy.test.js` (19 tests) — **one test per row of the severity table**, each row
    asserted for every direction it covers, replayed through the real pipeline on minimal
    spec pairs. Exposed one real gap: the "Endpoint deprecated" row promises a sunset date
    "if given", but operation-level `x-sunset` was never captured by the flattener and never
    reached the rule (dead branch in `rules.js`). Fixed the engine: `flatten.js` now records
    `sunset` on endpoints, `diff.js` passes it through; the table's promise now holds.
  - `test/pipeline.test.js` (28 tests) — every stage pinned in isolation: parse (4 refusals +
    passthrough), validate (problem lists, operation-less paths), resolve (broken refs named,
    including nested; refs fully replaced), flatten (route-shape identity, wire paths, allOf
    require-if-every-branch + unions, oneOf unions, enum/format/deprecated/x-sunset capture,
    array roots `[].`, x-internal at both levels, param locations), diff (zero-diff identity,
    path params pair by position vs query params by name, topmost-only subtree removals,
    unique ids + notes), classify (summarise, override honoured by differ, changeLocation),
    impact (route-shape + ANY matching, sends/reads direction, required-add coverage =
    the field itself or a child of it, subtree interest, SAFE affects nobody, unmatched
    reporting), verdict (block reason, PUBLISHED_OK counts) + humanSummary.
  - `test/api.test.js` (15 tests, **supertest**, new dev dependency) — the HTTP + persistence
    stages the pure suites cannot see: in-process Express app (`src/app.js`, extracted from
    `index.js` so nothing listens/seeds) against the real Postgres (compose now exposes it on
    127.0.0.1:15432, localhost-only) and the real webhook receiver. Pins: health, registration
    flows + validation errors, first publish (empty changelog, attempt + version rows, notified,
    event received), duplicate publish (409, rolled-back tx records no attempt), safe publish
    (deprecated findings reach the registered consumer, version row counts), dangerous publish
    (409, current unchanged, attempt impact persisted, notified), the three fail-safe refusals
    (resolve/parse/validate → 422 + ERROR attempts + failure notifications), preview records
    nothing, public diff (+404/400), metrics aggregates (per-service, unmatched usage signal,
    affected rollup), events feed, and the webhook-outage path (publish still succeeds,
    `notified=false`, delivery error recorded).
- Two suite-authoring corrections along the way (both first-time-green alignment, no
  assertions weakened): the required-add impact test initially assumed "sending the parent
  covers the new child", contradicting CONTEXT.md impact rule 4 ("that field or a child of
  it") which the engine implements — test corrected to encode the documented rule and now
  pins both halves; and the API suite initially read `current_version` off the detail
  endpoint (it lives on the list rows) and assumed policy v3 was version 1.2.0 (the kit
  file says 2.0.0) — both aligned with the real API/kit data.
- `impact.js` header comment fixed to match code + CONTEXT.md (child-of-it coverage, not
  parent-object coverage).
- npm scripts restructured: `npm test` = all 62 pure suites (no DB), plus `test:policy`,
  `test:pipeline`, `test:api`, `test:e2e`, `test:all`.
- **Result: 62/62 pure + 15/15 API + 11/11 E2E = 88 passing; DB reset to the pristine seed
  afterwards (3 services, 7 versions, 12 attempts, 12 notifications, 0 unmatched).**

---

## Verification evidence (final state)

- **Engine tests** `guard/test/engine.test.js` — 15/15: reorganisation fidelity (1 SAFE
  rename only), v2→v3 block with per-endpoint facts and `mobile-app` attribution, internal
  endpoint blocking with no consumer impact, enum widening = WARNING, retry-after-block,
  sunset-past wording, removal impacts (`payments-svc` hit, un-read field removal
  unaffected), endorsement narrowing + required addition hitting `partner-portal`, broken
  `$ref` refusal with stage, same-version fixed re-publish, response-optionalisation
  WARNING hitting `mobile-app`, route-shape consumer matching, first-version publish,
  external-ref/parse/validate refusals.
- **Policy tests** `guard/test/policy.test.js` — 19/19, one per severity-table row, both
  directions each; also pins the param rows, endpoint add/remove/deprecate (with `x-sunset`),
  body-required and status add/remove rows.
- **Pipeline tests** `guard/test/pipeline.test.js` — 28/28, one stage group per describe
  block: parse/validate/resolve refusals, flatten mechanics, diff pairing + topmost pruning,
  classify plumbing, impact matching rules, verdict + humanSummary.
- **API tests** `guard/test/api.test.js` — 15/15 (supertest, in-process app + real DB +
  real webhook receiver): persistence, blocking, notifications, HTTP contracts.
- **E2E tests** `guard/test/e2e.test.js` — 11/11 against the running stack (see list above).
- **Seed replay** (`docker compose logs guard`): 12 attempts — 7 published, 4 blocked,
  1 ERROR — matching the kit's intended story; 12 webhook notifications delivered to the
  receiver; metrics show 0 unmatched usages and the expected most-affected ranking
  (`mobile-app` first).
- **UI**: all five pages exercised in-browser; publish preview/publish flows wired; zero
  console errors.

## How to re-verify from scratch

```bash
docker compose down -v && docker compose up --build   # pristine DB + fresh seed
docker compose logs guard                              # seed replay: verdicts per version
cd guard && npm test                                   # 62 pure tests (engine + policy + pipeline)
npm run test:api                                       # 15 API tests (supertest, uses the stack)
node --test test/e2e.test.js                           # 11 E2E tests (then reset again)
```

---

## Deferred / next steps (not built, by design or stage)

1. **Manual review queue** — PO said "notify the user about the failure"; overrides/
   approvals would need an auth model first. The webhook + attempts UI is the interim.
2. **Auth & multi-tenancy** — no login yet; publish endpoints are open.
3. **Usage lifecycle** — "last verified at" timestamps and stale-usage nudges; unmatched
   usage surfacing currently covers the detection half.
4. **Richer OpenAPI coverage** — parameter locations beyond path/query/header/cookie are
   skipped by the flattener; `not` schemas; multi-content-type per response; webhooks/
   callbacks sections.
5. **Notification channels** — one webhook today; per-team routing/slack/email adapters
   would slot into `notify.js`.
6. **Semver awareness** — versions are opaque strings; a major-version bump could
   auto-escalate or relax certain findings.
