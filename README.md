# Contract Guard

An **API contract registry with a guard rail**, built on the contract-guard starter kit.
Teams publish each version of their API's OpenAPI specification; Contract Guard diffs every
candidate version against the currently published one **at the wire level**, classifies every
change (`DANGEROUS` / `WARNING` / `DEPRECATED` / `SAFE`), computes **which registered consumer
services would be affected**, and **stops the publish when a dangerous change is found** —
while keeping a permanent, browsable record of every attempt.

```
docker compose up --build        # from this folder
```

- **Contract Guard** (API + UI) → http://localhost:9901
- **Webhook receiver** (chat/email stand-in, unchanged from the kit) → http://localhost:9900

On first boot the app imports the kit's `specs/` and `consumers/` folders: every spec version
is replayed through the real publish pipeline, so versions, attempts, verdicts and webhook
notifications all exist out of the box. With the kit data that means 7 published versions,
4 blocked publishes, 1 refused publish (the planted broken `$ref`) and 12 notifications.
(`SEED_ON_BOOT=0` disables seeding.)

## What it does

- **Wire-level comparison, not file-level.** `$ref`s are resolved, route shapes are normalised
  (`/quotes/{id}` ≡ `/quotes/{quoteId}`) and schemas are flattened to field paths
  (`premium.breakdown[].amount`). The kit's "reorganised" spec diffs as exactly one cosmetic
  rename — component renames, inlining and ref reshuffles produce no phantom changes.
- **Direction-aware severity policy.** Relaxing what a server accepts is safe; tightening it
  is not. Adding to a response is safe; removing from it is not. New required request fields
  or parameters, removed response fields, type changes, enum narrowing on requests,
  endpoint/status removals and body tightening are `DANGEROUS` and block the publish.
  Response enum widening and response requirement relaxation are `WARNING` (may affect
  consumers depending on how they use it). Deprecations are `DEPRECATED`, honouring
  `x-sunset` dates (past dates are called out). Everything else is `SAFE`.
- **Consumer impact.** Consumers register what they call (method + path template, `sends`,
  `reads`). Every change is matched against those registrations: a new required request field
  hits callers not already sending it; removed/changed fields hit whoever reads or sends that
  subtree; whole-route changes hit every caller. `SAFE` changes affect nobody by definition.
- **Fail safe.** If the pipeline cannot fully verify a spec — bad YAML, missing
  `info.version`, broken `$ref` — the publish is refused (HTTP 422) with the failing stage
  named, recorded as an `ERROR` attempt, and notified. The guard never passes a spec it
  could not understand, and never silently swallows a blocked change.
- **Full audit trail.** Every publish attempt (published / blocked / refused) is stored with
  its analysis, affected consumers and the raw submitted spec. Blocked specs never become the
  baseline: a later retry still diffs against the last good version.
- **Notifications.** Every outcome (`publish.succeeded` / `publish.blocked` /
  `publish.failed`) is POSTed to the webhook with a human-readable summary, counts and
  affected consumers. Delivery problems never break the pipeline and are visible in the UI.

## Documentation

| Document | Contents |
| --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | **The complete project context** — pipeline walkthrough, dataflow, wire model, severity policy, impact rules, data model, API reference, UI navigation, operations, design decisions |
| [`DESIGN.md`](DESIGN.md) | **Architecture definition** — context/component/runtime/data/interface/deployment views, decision records with alternatives, cross-cutting concerns, quality attributes, glossary |
| [`guard/README.md`](guard/README.md) | The same ground from the app folder's perspective (API, policy, layout, tests) |
| [`PLAN.md`](PLAN.md) | The original problem statement and PO Q&A |
| [`DECISIONS.md`](DECISIONS.md) | PO answers (verbatim record) |
| [`PROGRESS.md`](PROGRESS.md) | Build log: what was delivered, in order, with verification evidence and fixes |

## HTTP API (summary)

```
POST /api/services/:slug/publish        body = YAML -> 201 published / 409 blocked / 422 refused
POST /api/services/:slug/preview        same analysis as a dry run, records nothing
GET  /api/services/:slug/diff?from=A&to=B   diff any two published versions + current impact
GET  /api/services                      ·  /api/services/:slug  ·  /api/services/:slug/versions[/:version]
GET  /api/services/:slug/attempts       every publish attempt, full changelog
GET  /api/consumers                     ·  POST /api/consumers  ·  POST /api/consumers/:slug/usages
GET  /api/metrics                       totals, severity mix, most-affected consumers, unmatched usages
GET  /api/events                        webhook notification log
```

## UI

**Services** (list + register) · **Service page** (publish with preview, current endpoints,
version history & changelog, every attempt with verdict and impact, consumers of this API) ·
**Diff** (any two versions, or analyse an unregistered candidate spec) ·
**Impact & Metrics** (registry-wide stats, most-affected consumers, per-service table,
recent attempts, unmatched usages, notification log) · **Consumers** (register + declare
usages).

## Tests

```
cd guard
npm test              # 62 tests, no DB needed:
                      #   test/engine.test.js   15 - every planted kit scenario through analyse()
                      #   test/policy.test.js   19 - one test per severity-table rule (both directions)
                      #   test/pipeline.test.js 28 - each pipeline stage pinned in isolation
npm run test:api      # 15 supertest tests - the HTTP + persistence stages (attempts,
                      #   versions, blocking, notifications, 201/409/422) in-process
                      #   against the real DB; needs docker compose up -d
npm run test:e2e      # 11 end-to-end tests against the running stack on :9901
                      # (both suites above write test data; docker compose down -v afterwards)
```

All 88 pass. The engine tests pin every planted kit scenario (reorganisation fidelity,
broken `$ref` refusal, deprecations with sunset dates, removals hitting `payments-svc`,
enum narrowing and required additions hitting `partner-portal`, response-field
optionalisation) so rule changes that would misidentify a scenario fail loudly. The
policy suite encodes the severity table one rule per test, and the pipeline suite
covers every stage from parse to verdict — if an engine change mislabels a rule or
breaks a stage, a test names it.

## Tech stack

Node 20+, Express 5, `pg` (Postgres 16), `js-yaml`, Docker Compose. UI is vanilla JS
with no build step. Source lives in `guard/` (engine in `guard/src/lib/`, pipeline in
`guard/src/services/`, schema in `guard/src/schema.sql`, UI in `guard/src/ui/`).

---

## The starter kit (reference)

Everything below is the original kit material — the inputs Contract Guard reads and the
rules the evaluators test against.

### Start the kit

- **Docker:** `docker compose up --build`
- **Podman:** `podman compose up --build` (needs `podman compose` or `podman-compose`)

The **webhook receiver** stands in for chat and email: anything POSTed to it appears on its
page. `GET /api/received` returns the list as JSON, and `DELETE /api/received` clears it.
If port 9900 is already in use, start the kit with another port, for example
`WEBHOOK_PORT=9950 docker compose up --build` (and point `WEBHOOK_URL` at it).

### API specifications: `specs/`

Three provider services, each with four versions of their OpenAPI 3.0.3 specification,
numbered in the order the owning team wants to publish them:

| Service | Owner | Files |
| --- | --- | --- |
| `quote-api` | Quotes team | `specs/quote-api/1-initial.yaml` … `4-ncb-and-taxes.yaml` |
| `policy-api` | Policy team | `specs/policy-api/1-initial.yaml` … `4-endorsement-rules.yaml` |
| `claims-api` | Claims team | `specs/claims-api/1-initial.yaml` … `4-approval-later.yaml` |

- The version number of each specification is in `info.version`.
- Specifications reuse components through `$ref`. All references point inside the same file.
- `x-internal` marks operations only internal teams may call; `x-sunset` marks a planned
  removal date — Contract Guard honours both (diffed but matched to no consumer; sunset
  dates surfaced in DEPRECATED notes).
- Some versions contain problems Contract Guard is built to catch.

### Consumers: `consumers/`

One YAML file per calling service: `mobile-app`, `partner-portal`, `payments-svc` and
`notifications-svc`, declaring which endpoints each calls, what it sends and what it reads
(dots for nesting, `[]` for list items). The kit's four consumers are imported on first boot
and can be managed from the **Consumers** page or the API.

### Kit rules

- **Don't change the files in `specs/` or `consumers/`**: the evaluators test your product
  against the original kit. Copy them if you want to experiment.
- How Contract Guard reads these files (upload through your API or UI, import from the
  folder, or both) is your decision — this build does both: folder import on first boot,
  then upload/API/UI afterwards.
