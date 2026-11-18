# DESIGN — Contract Guard

Architecture definition for the Contract Guard service: what the system is, how it is
structured, how it behaves at runtime, why every consequential decision was made, and
where future work is expected to plug in.

| | |
| --- | --- |
| **Audience** | Engineers extending or operating Contract Guard; reviewers judging the design; evaluators running the kit |
| **Scope** | The built product as of commit `b38d01c` — no plans, no "could"s except in §12 (extension points) |
| **Companion docs** | [`README.md`](README.md) (product + quickstart) · [`CONTEXT.md`](CONTEXT.md) (product context, policy, API/UI reference) · [`PROGRESS.md`](PROGRESS.md) (build log + verification evidence) |

---

## 1. Purpose and problem statement

Service teams publish OpenAPI specs; the consumers of those APIs are other internal
teams whose code compiles against shapes the spec describes. When a spec changes, the
people who break are the consumers — and nobody notices until runtime. Contract Guard
is the enforcement point between the two:

> Every spec version is diffed against the currently published version on the *wire*,
> every change is classified by direction-aware severity rules, every registered
> consumer usage is matched against every change, and a publish that would break a
> consumer is refused automatically — with the damage report sent to chat before the
> refusal lands.

Two properties define the product:

1. **Fail safe.** A spec the guard cannot fully analyse is a *failed publish*, never a
   silent pass. The stage that failed is named.
2. **Notify, don't queue.** Blocks, failures and deprecations are announced on the
   webhook. There is no manual-review/approval flow (explicit product-owner policy).

---

## 2. System context

```
                              publishes specs (YAML)
   Provider teams  ────────────────────────────────────────┐
   (owners of APIs)                                        │
                                                           ▼
                                            ┌──────────────────────────────┐
   Consumer teams  ─── register usages ───▶ │      CONTRACT GUARD          │
   (callers of APIs)  method, route shape,  │   REST API  :9901  + SPA     │
                      sends[], reads[]      │                              │
                                            │  ┌────────┐    ┌──────────┐  │
   Platform leads  ◀── webhook events ──────┼─▶│ Postgres│    │ webhook  │  │
   (notified on publish /                   │  └────────┘    │ receiver │  │
    block / failure)                        │                └──────────┘  │
                                            └───────┬──────────────▲───────┘
   Evaluators / CI ◀── runs npm test suites ┘       seed on │              │
   (specs/, consumers/ folders, read-only)          boot: replay │ notifications│
                                                     kit folders │ (HTTP POST)  │
                                                                 ▼              │
                                                    first versions published ───┘
```

**Actors and their contracts with the system**

| Actor | Interaction | Trust boundary |
| --- | --- | --- |
| Provider team | `POST /publish` with raw YAML; `GET` diffs, versions, attempts | Unauthenticated this stage (§10.3); slug-scoped access only |
| Consumer team | Registers consumer + usages (`sends[]`/`reads[]` are declared, not discovered) | Self-declared data; drives impact only |
| Platform leads | Webhook `POST`s; the SPA for review | Read-only recipients |
| Webhook receiver | Stand-in for chat/email; stores every event | Never blocks the pipeline (§9-D9) |
| Evaluators | Own `specs/` and `consumers/` folders; the system reads them only at seed | Folders are immutable inputs |

The system holds **no secrets and no credentials**: it is a registry + analyser, not a
gateway. It never proxies API traffic; it reasons about *descriptions* of traffic.

---

## 3. Design principles

These constrain every decision below and explain most of them:

1. **The wire is the truth.** Two specs that describe the same API must produce the same
   internal model, regardless of how the files are organised (`$ref` graphs, component
   names, inlining). Diffing anything less (raw YAML, raw JSON trees) reports file
   editing, not contract change.
2. **Purity where it pays.** The analysis engine (parse → verdict) has zero I/O and zero
   DB access. That is what makes 62 of the 88 tests run with no infrastructure, and the
   remaining 26 deterministic against real ones.
3. **Refuse > guess.** Any spec the pipeline cannot fully understand stops the publish
   with a named stage (`parse`, `validate`, `resolve`). Partial analysis is never shown
   as a verdict.
4. **One code path.** Seeding replays the kit's folders through the *same* `publish()`
   the API uses. There is no import shortcut whose behaviour can drift from the
   pipeline's.
5. **Audit what you enforce.** Every attempt — published, blocked, or errored — is
   stored with its raw input, counts, impact and notification outcome. The registry can
   always answer "what did we know, when, and who was told".

---

## 4. Component view

```
┌─────────────────────────── guard/ ─────────────────────────────────────────┐
│                                                                           │
│  HTTP layer            index.js ─ boot: initSchema → seedIfEmpty → listen │
│  (thin)                app.js  ─ Express app (extracted: supertest target) │
│                        routes.js ─ 16 endpoints, asyncH, error mapping    │
│                             │                                             │
│  Service layer         services/publish.js ─ pipeline orchestration       │
│  (stateful)            services/registry.js ─ CRUD, detail, metrics       │
│                             │                                             │
│  Engine (PURE, no I/O) analyse.js ─ composition root of the stages         │
│                        lib/yaml.js      parse (GuardError stage: parse)   │
│                        lib/openapi.js   validate + resolve ($refs)        │
│                        lib/flatten.js   wire model                        │
│                        lib/diff.js      structural diff + change shapes   │
│                        lib/rules.js     severity classification (the table)│
│                        lib/impact.js    usage matching → affected[]       │
│                        lib/pathutils.js wire-path algebra                 │
│                        lib/errors.js    GuardError(stage, detail)         │
│                             │                                             │
│  Persistence           db.js (pool, withTx) + schema.sql                  │
│  Side-effects          notify.js (webhook + audit row)                    │
│  Boot data             seed.js (replay specs/ + consumers/)               │
│  Frontend              ui/ (vanilla SPA, no build step)                   │
└───────────────────────────────────────────────────────────────────────────┘
```

**Responsibilities and allowed dependencies**

| Component | Responsibility | May depend on |
| --- | --- | --- |
| `routes.js` | Parse HTTP, load service by slug, map `HttpError` → status | service layer only |
| `services/publish.js` | The publish pipeline (§5); owns `HttpError` | db, engine, notify |
| `services/registry.js` | Registration, listings, detail views, metrics, unmatched-usage scan | db, `HttpError` |
| `analyse.js` | Run all engine stages in order; return `{doc, flat, changes, counts, impact, verdict}` | lib/* only |
| `lib/*` | Each one stage or support concept; throw `GuardError` with stage | each other, js-yaml |
| `notify.js` | Deliver webhook with 5 s timeout; always write a `notifications` audit row | db, config |
| `seed.js` | First-boot replay (§5.4) | registry + publish services |

**The dependency rule:** arrows point downward only. The engine never imports the
service layer, `db.js`, or Express. This is enforced structurally (imports), not by
convention, and is the reason `test/policy.test.js` and `test/pipeline.test.js` need no
database.

---

## 5. Runtime view

### 5.1 The publish pipeline (the heart of the system)

```
POST /api/services/:slug/publish        (raw YAML body, or JSON {"yaml": ...})
 │
 ├─ 1. load service, current baseline (flat of the *published* version), usages
 │
 ├─ 2. analyse(yaml, baselineFlat, usages)          ── pure engine ──
 │      parse ─▶ YAML mapping or GuardError(parse)
 │      validate ─▶ openapi/info.version/paths/operations checks
 │      resolve ─▶ every $ref replaced; broken/external refs → GuardError(resolve)
 │      flatten ─▶ wire model: endpoints keyed METHOD + route shape,
 │                 fields flattened to wire paths (`premium.breakdown[].amount`)
 │      diff ─▶ baseline vs candidate; topmost-only changes; unique ids
 │      classify ─▶ severity + note per change (direction-aware table)
 │      impact ─▶ usages × changes → change.affected[] + consumer rollup
 │      verdict ─▶ BLOCKED iff any DANGEROUS, else PUBLISHED_OK
 │
 ├─ 3a. GuardError? ─▶ record ERROR attempt (stage, message, raw spec)
 │                     ─▶ notify publish.failed ─▶ set attempt.notified
 │                     ─▶ HTTP 422 {status: ERROR, stage, error}
 │
 ├─ 3b. single DB transaction:
 │        insert attempt (PUBLISHED | BLOCKED)
 │        if BLOCKED ─▶ commit, done (baseline unchanged — see 5.2)
 │        duplicate version? ─▶ throw 409 → tx ROLLS BACK (no attempt row)
 │        insert version, repoint services.current_version_id
 │
 ├─ 4. notify publish.succeeded | publish.blocked ─▶ set attempt.notified
 │
 └─ 5. HTTP 201 (published) | 409 (blocked), body = counts + changes + impact
```

Key invariants:

- **Steps 1–2 are read-only.** Nothing is persisted before a verdict exists.
- **The attempt row and the version row are born in one transaction.** A refused
  duplicate leaves *no* trace (the `INSERT attempt` rolls back with the version insert).
- **`raw` is retained on every attempt**, so any verdict can be re-examined byte-exactly.

### 5.2 Attempt lifecycle and the baseline rule

```
        publish() called
              │
     ┌────────┼─────────────┐
     ▼        ▼             ▼
 PUBLISHED  BLOCKED       ERROR
 (version   (attempt only, (attempt only,
  created,   is NOT new     stage named,
  becomes    baseline)      raw kept)
  baseline)
     │           │            │
     └───────────┴────────────┘
        all three are terminal; notified flag set iff webhook accepted
```

- The diff baseline is **always the current published version** (`services.current_version_id`).
- A blocked spec is *never* the baseline. A fixed retry therefore still shows the
  carried-over dangerous changes (they were never published, so they are still new) —
  the `guard/test/engine.test.js` "quote v4" test pins this.
- `attempt_no` is per-service monotonic and unique; `revision` is the same for versions.

### 5.3 Public diff (`GET /services/:slug/diff?from=&to=`)

Loads both stored `flat` models and **re-runs diff + classify + impact with the current
consumer registrations**. Diffs are recomputed, not replayed, so a diff always answers
with today's consumer registry — the historical attempt rows stay frozen.

### 5.4 Boot sequence and seeding

```
initSchema (idempotent DDL) → seedIfEmpty (best effort, never fatal) → listen
```

Seeding (only when `SEED_DIR` set, `SEED_ON_BOOT≠0`, and the registry is empty):

1. Register each `specs/<service>/` as a service (owner extracted from `info.description`).
2. Publish every spec's **first** version (empty changelogs).
3. Register the `consumers/` folder: consumers and their usages.
4. Publish the remaining versions **through `publish()`**, in filename order — so impact
   analysis sees the consumers before the changes that affect them, and every attempt
   (12 in the shipped kit: 7 published / 4 blocked / 1 error) exists in the DB exactly
   as a live publish would have produced it.

Seed failure is logged and swallowed: a broken seed must not stop the registry from
serving (the empty registry surfaces the problem on its own).

---

## 6. Data view

```
services ──< versions >── publish_attempts ──< notifications
   │             │                │
   │             │                └─ attempt_no, status(PUBLISHED|BLOCKED|ERROR),
   │             │                   counts, changes, impact, raw, notified
   │             └─ revision, version UNIQUE(service), spec, flat,
   │                changes, counts, impact, attempt_id
   └─ current_version_id ─▶ versions.id        (the baseline pointer)

consumers ──< consumer_usages >── services
                 UNIQUE(consumer, provider, method, path)
                 sends JSONB, reads JSONB
```

| Table | Role | Notable columns |
| --- | --- | --- |
| `services` | The registry's anchor entity | `current_version_id` (baseline pointer) |
| `versions` | Immutable published snapshots | `spec` (parsed doc) **and** `flat` (wire model) both stored |
| `publish_attempts` | Every pipeline run, outcome included | `raw`, `error_stage`, `notified`, `CHECK (status IN (...))` |
| `consumers` / `consumer_usages` | Declared integrations | unique constraint makes usage upserts idempotent |
| `notifications` | Webhook delivery audit | `status_code`, `error`, `attempt_id` |

Why both `spec` and `flat` are stored per version: `flat` is the next diff's baseline
(makes diff/preview O(1) in history), `spec` is the display/re-export copy. Both are
JSONB — the shapes are versionable and irregular, while identity and lifecycle
(uniqueness, attempts, revisions, foreign keys) stay relational.

The **wire model** (stored as `flat`) is the architecture's central data structure:

```
{ title, version, endpoints: [
    { key: "GET /quotes/{}",           method + route shape (params → {})
      path: "/quotes/{quoteId}",       written path (display only)
      internal, deprecated, sunset,
      pathParams / queryParams / headerParams / cookieParams,
      request:  { present, required, fields: FieldNode[] },
      responses:{ "200": { fields: FieldNode[] } } ] }

FieldNode = { path: "premium.breakdown[].amount", type, required, enum,
              format, deprecated, sunset, union }
```

Two flattening rules give the model its diff-stability: `allOf` merges branches (a field
is required only if *every* branch requires it; differing branch types become a `union`
node), and array roots root their item fields at `[].` (`[].id` for a top-level list).

Change identity is stable and human-readable: `${kind}|${endpointKey}|${path|name}|${direction}`.

---

## 7. Interface view

Sixteen endpoints, four groups (full reference with examples: `CONTEXT.md` §7).

| Group | Endpoints | Notes |
| --- | --- | --- |
| Registry | `GET/POST /services`, `GET /services/:slug`, `/versions`, `/versions/:version`, `/attempts` | detail view joins attempts + usages + current flat |
| Pipeline | `POST /services/:slug/publish`, `/preview`, `GET /diff` | preview is analyse-only: no rows, no notifications |
| Consumers | `GET/POST /consumers`, `POST /consumers/:slug/usages`, `DELETE /usages/:id` | usages upsert on the natural key |
| Observability | `GET /health`, `/metrics`, `/events` | health is DB-probing (503 when Postgres is down) |

**Status-code contract** (pinned by `test/api.test.js`):

| Code | Meaning |
| --- | --- |
| 201 | version published, became current |
| 409 | blocked by policy **or** duplicate version (body distinguishes: `status: BLOCKED` vs `already_registered`) |
| 422 | publish refused, spec unanalysable — body names `stage: parse\|validate\|resolve`, attempt recorded as ERROR |
| 400 | malformed request (slug, method, missing body) |
| 404 | unknown slug/version/usage |
| 503 | `/health` when the DB is unreachable |

---

## 8. Deployment view

```
docker compose (host ports: guard 9901, webhook 9900, db 127.0.0.1:15432)

┌──────────────┐   seed reads    ┌───────────────────┐
│ ./specs,     │──(read-only)──▶ │ guard             │──▶ webhook-receiver :9000
│ ./consumers  │                 │ (Node 20, :3000)  │        (stores events,
└──────────────┘                 └────────┬──────────┘         GET /api/received)
                                          │
                                 ┌────────▼──────────┐
                                 │ postgres:16-alpine│  guard-db volume
                                 │  (guard/guard)    │  exposed to host on
                                 └───────────────────┘  127.0.0.1 only, for
                                                        the supertest suite
```

| Env var | Default | Effect |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port (compose maps 9901 → 3000) |
| `DATABASE_URL` | localhost Postgres | connection string |
| `WEBHOOK_URL` | *(empty = notifications off)* | fire-and-forget target; `notify()` no-ops gracefully when unset |
| `SEED_DIR` / `SEED_ON_BOOT` | — / `1` | enables first-boot replay of the kit folders |
| `PUBLIC_URL` | — | *declared, not yet consumed* (reserved for links in webhook payloads) |

The DB host port is bound to `127.0.0.1` specifically so `test/api.test.js` can drive the
real database from the host while the container network still keeps Postgres private to
the stack. All three services restart cleanly; `docker compose down -v` restores the
pristine seed.

---

## 9. Design decisions

Each decision: what was chosen, why, what was rejected, and what it costs.

**D1 — Diff the wire model, not the spec.**
Refs are resolved, routes normalised (`{quoteId}` ≡ `{id}`), schemas flattened to wire
paths before any comparison.
*Why:* reorganisations (renamed components, reshuffled refs — the kit's quote v1→v2) must
diff clean; consumers break on shapes, not files.
*Rejected:* raw-tree diffs (report file editing), JSON-schema-aware third-party differ
(cannot express our direction-aware severities or consumer impact).
*Cost:* the flattener is the largest single module and defines coverage limits (§12).

**D2 — Severity is one direction-aware table, in one module.**
Every structural fact gets exactly one severity + note from `lib/rules.js`; the table
(19 rows) is reproduced one-row-per-test in `test/policy.test.js`.
*Why:* predictability is the product — a team must be able to know before submitting
what will block. One table, one place, one test per row.
*Rejected:* per-service rule configuration (no owner asked for it), severity by semver
bump (versions are opaque strings this stage).
*Cost:* policy changes are code changes — deliberate; the table is the policy.

**D3 — Fail safe on unanalysable specs; name the stage.**
Parse/validate/resolve failures stop the publish (422), record an ERROR attempt with the
raw spec, and notify.
*Why:* "silently publish what we could read" is precisely the failure mode Contract
Guard exists to prevent; a stage name makes the refusal actionable.
*Rejected:* best-effort partial verdicts (unfalsifiable), auto-retry (hides the failure).
*Cost:* a trivially-broken spec is refused rather than waived — intended.

**D4 — Dangerous publishes are blocked automatically; no manual review.**
No approval queue, no override endpoint (product-owner policy).
*Why:* the guard's value is being automatic; a review queue is an auth+workflow product.
*Cost:* a false-positive block costs a fix-and-resubmit cycle; the impact report in the
409 body exists to make that cycle fast.

**D5 — Blocked specs never become the baseline.**
The diff baseline is always the last *published* version.
*Why:* otherwise a dangerous change could be normalised away by an intervening blocked
publish, then land silently in a later approve-worthy version.
*Cost:* retries re-report carried-over findings — intended and tested (engine suite).

**D6 — Impact is attached to changes; SAFE affects nobody by definition.**
`computeImpact` writes `change.affected[]` (per usage, with a `via` reason) directly onto
each change; the consumer rollup keeps only consumers with ≥1 finding.
*Why:* the UI's question is "this change — who does it hurt?", and a SAFE change must
never manufacture consumer findings (noisy registries get ignored).
*Cost:* none observed; matching is conservative and fails toward *more* attribution.

**D7 — Matching is route-shape-based and declared, not inferred.**
Usages match by method (or `ANY`) + normalised route; `sends[]`/`reads[]` decide
request-side vs response-side attribution; unmatched declared routes are surfaced as a
data-quality signal, never an error.
*Why:* consumers know their own calls; discovery (parsing consumer code) is out of
scope and fragile.
*Cost:* stale declarations degrade impact quality — which is exactly what the
unmatched-usage metric exposes.

**D8 — Required-field coverage is "the field itself or a child of it".**
A new required request field affects every usage that doesn't declare sending that field
*or a child of it* (`via: "does not send rider.ncb"`).
*Why:* fail-safe direction — sending the parent object does not prove a new child is
populated; only a declaration covering the path proves coverage.
*Cost:* over-attribution when consumers send dynamic objects; accepted (policy in
`CONTEXT.md` §5, pinned by `test/pipeline.test.js`).

**D9 — Notifications are fire-and-forget with a mandatory audit trail.**
`notify()` posts with a 5 s timeout; win or lose it writes a `notifications` row and the
attempt's `notified` flag records the outcome. A webhook outage never fails a publish.
*Why:* the pipeline's verdict is the product; the webhook is a mirror. Making delivery
load-bearing would couple enforcement to a chat bot's uptime.
*Rejected:* retries/queues (no infra for it; the audit row + `/events` view covers
post-hoc inspection).

**D10 — Postgres with relational identity + JSONB payloads.**
Uniqueness, FKs, attempt numbering and metrics live in SQL; `spec`, `flat`, `changes`,
`impact` live in JSONB.
*Why:* the workload is a low-volume registry with report-shaped payloads; JSONB keeps
schema evolution cheap without giving up transactional publish semantics.
*Rejected:* document store (no joins for metrics), flat SQL columns (schema churn).

**D11 — One publish code path, used by seed and API alike.**
`seed.js` calls `services/publish.js#publish` directly.
*Why:* a separate import path is a second implementation that *will* drift; the seeded
DB must be exactly what live usage produces.
*Cost:* seed depends on the full service layer — fine, it runs inside the app.

**D12 — Purity boundary for testability.**
The engine is I/O-free; `app.js` is extracted from `index.js` so supertest drives HTTP
in-process (no listen, no seed) against the real DB.
*Why:* 62/88 tests run with zero infrastructure in ~1 s; the 26 infrastructure tests
remain deterministic because they hit real Postgres/webhook, not mocks.
*Cost:* one extra module (`app.js`); negligible.

---

## 10. Cross-cutting concerns

### 10.1 Error taxonomy
| Error | Source | Surface |
| --- | --- | --- |
| `GuardError(stage)` | engine, on unanalysable specs | publish → 422 `{status: ERROR, stage, error, brokenRefs?|problems?}`; attempt ERROR |
| `HttpError(status)` | service layer, on policy/validity | route → status + `{error, ...extra}` |
| unexpected | bugs | 500 `{error: "Contract Guard hit an unexpected error; ..."}` — message logged, stack never leaked |

### 10.2 Validation and limits
Slug regex, HTTP-method whitelist, `sends/reads` must be string arrays, paths must start
with `/`; bodies capped at 5 MB; YAML must parse to a mapping (JSON_SCHEMA — no arbitrary
tags). All DB writes are unique-constrained; `initSchema` is idempotent.

### 10.3 Security posture (this stage)
No authentication/authorisation — every endpoint is open on the LAN port; this is a
declared stage boundary (auth is §12's first extension point, with the middleware slot
already isolated in `app.js`). The system holds no secrets; the DB port is
localhost-bound; error responses never leak stacks. Specs are stored, not executed.

### 10.4 Observability
`/health` (DB probe), `/metrics` (totals, severity totals, affected-consumer ranking,
per-service rollup, unmatched usages), `/events` (last 30 webhook deliveries with
outcome); seed and delivery log to stdout. Every enforcement action is reconstructible
from `publish_attempts` + `notifications`.

---

## 11. Quality attributes → mechanisms

| Attribute | Mechanism in this design |
| --- | --- |
| Diff fidelity (no reorganisation noise) | D1 wire model; `flat` stored per version; engine test pins quote v1→v2 = 1 SAFE rename |
| Fail-safety | D3 stage-named refusals; D5 baseline rule; 500s without stack leaks |
| Explainability | every change: `kind`, `location`, `note`, `severity`, `affected[].via` |
| Auditability | attempts keep `raw`; notifications keep `status_code`/`error`; `notified` flag |
| Determinism of enforcement | D2 single table; one test per row; engine purity (D12) |
| Operability | one `docker compose up`; seed-on-boot; `down -v` = pristine; env-only config |
| Evolvability | downward-only deps; new change kinds = rules.js row + policy test; §12 slots |

---

## 12. Extension points (designed gaps, not features)

| Future need | Slot it already has |
| --- | --- |
| Auth / multi-tenancy | middleware position in `app.js`; `owner_team` on services, `team` on consumers |
| Per-team notification routing | `notify.js` is the single delivery seam |
| New severity rows / change kinds | `lib/rules.js` (classification) + `lib/diff.js` (fact) + a `test/policy.test.js` row |
| Semver-aware policy | verdict composition in `analyse.js`/`publish.js`; versions currently opaque |
| Usage lifecycle ("last verified") | `consumer_usages` columns + the unmatched-usage scan in `registry.js#metrics` |
| Richer OpenAPI coverage | the flattener's coverage limits (e.g. `not`, callbacks, multi-content-type) are localised in `lib/flatten.js` |
| Webhook payload links | `PUBLIC_URL` is already plumbed into `config.js` (unused) |

---

## 13. Glossary

| Term | Meaning |
| --- | --- |
| **Wire model** | Resolved + flattened internal representation of a spec (`flat`); the diff substrate |
| **Route shape** | Path with params normalised to `{}`; endpoint identity = METHOD + shape |
| **Wire path** | Flattened field address, e.g. `premium.breakdown[].amount`; array roots use `[].` |
| **Baseline** | The flat of the currently *published* version; blocked specs never become it |
| **Attempt** | One pipeline run: PUBLISHED, BLOCKED or ERROR; keeps the raw input |
| **Verdict** | `PUBLISHED_OK` (analysis-level) → surfaced as PUBLISHED/BLOCKED (attempt-level) |
| **Severity** | DANGEROUS (blocks) / WARNING / DEPRECATED / SAFE; direction-aware |
| **Usage** | A consumer's declared call: method, path, `sends[]`, `reads[]` |
| **Affected** | Per-change list of impacted usages with a `via` reason |
| **Unmatched usage** | Declared route matching no current endpoint — data-quality signal |
| **Sunset** | `x-sunset` removal date attached to a deprecation; past dates are called out |

---

*Norms note: this document follows a pragmatic arc42/C4 structure — context view (§2),
component view (§4), runtime view (§5), data view (§6), interface view (§7),
deployment view (§8), decision records (§9) — with cross-cutting concerns, quality
attributes and a glossary as required sections. Diagrams are ASCII so they diff and
review like the rest of the repository.*
