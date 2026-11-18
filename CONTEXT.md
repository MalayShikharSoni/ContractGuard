# Contract Guard — Project Context

This document is the single source of truth for what Contract Guard is, how its pipeline
works, how data flows through it, what it can do, and how to operate it. Read this and
you have the whole project context; every claim here reflects the code as built.

- Code: `guard/` (this kit root), specs/consumers are the read-only kit inputs.
- Run: `docker compose up --build` from this folder → UI/API on **http://localhost:9901**,
  webhook receiver stand-in on **http://localhost:9900**.

---

## 1. What it is

**Contract Guard is an API contract registry with a guard rail.** Teams publish each
version of their service's OpenAPI specification. For every new candidate version the
system:

1. diffs it against the **currently published** version at the *wire level* (what the API
   accepts and returns — not how the file is organised),
2. classifies every change as `DANGEROUS` / `WARNING` / `DEPRECATED` / `SAFE`,
3. computes **which registered consumer services would be affected** and why,
4. **stops the publish** if any change is `DANGEROUS`, and
5. records **every attempt** (published, blocked, or failed) permanently in the
   changelog, and notifies the platform via webhook.

Users: engineers who own APIs (publishers), engineers whose services call them
(consumers registering usage), and platform leads (impact/metrics overview, audit trail).

PO-answered policy encoded in the product:
- Request/response direction semantics are decided by the engine (see §6).
- Beyond SAFE/DANGEROUS there are WARNING and DEPRECATED (with `x-sunset` dates honoured).
- New-but-unused elements are additive: they appear in the changelog as `SAFE` and do
  **not** raise consumer findings.
- **Fail safe**: if the pipeline cannot fully verify a spec (bad YAML, missing metadata,
  broken `$ref`, …) the publish is *refused* with the failing stage named — never
  silently passed.
- Blocked changes are not silently dropped either: the attempt is recorded and the
  webhook notifies people (chat/email stand-in), i.e. "notify the user about the failure".

---

## 2. Quick facts

| | |
| --- | --- |
| Stack | Node 20+, Express 5, `pg` (Postgres), `js-yaml`, Docker Compose |
| Process | single Node process: REST API + static UI + seeding + webhook client |
| Database | Postgres, schema auto-created on boot (`guard/src/schema.sql`) |
| Ports | `9901` = Contract Guard (`GUARD_PORT`), `9900` = webhook receiver (`WEBHOOK_PORT`) |
| First boot | imports kit `specs/` + `consumers/` through the real publish pipeline (`SEED_ON_BOOT=1`, `SEED_DIR=/kit`) |
| Tests | `guard/test/engine.test.js` (15, pure, no DB) + `guard/test/e2e.test.js` (11, live stack) |
| UI | vanilla JS SPA, no build step, hash routing (`guard/src/ui/`) |

---

## 3. Architecture at a glance

```
                ┌──────────────────────────────────────────────────────┐
                │                    Contract Guard                     │
 publisher ────▶│  Express API ─ publish pipeline ─▶ Postgres           │
 (spec YAML)    │        │                (services, versions,         │
 consumer ─────▶│        │                 attempts, usages, ...)      │
 (usage YAML/   │        ├── preview (dry run, nothing recorded)       │
  JSON via API) │        └── notify ──▶ WEBHOOK_URL (chat/email)        │
 platform ─────▶│  Static SPA (Services / Service / Diff / Impact /     │
 (browser)      │             Consumers) ── fetch /api/*                │
                └──────────────────────────────────────────────────────┘
```

One container (`guard`), one Postgres, the kit's webhook receiver. The seed mount is
read-only (`./specs`, `./consumers`).

---

## 4. The wire model (core idea)

Everything the guard reasons about is a **flattened wire model** produced from a spec:

```
flat = {
  title, version,
  endpoints: [
    {
      key: "POST /quotes",          // METHOD + route shape (params normalised to {})
      method, path, internal, deprecated, operationId,
      pathParams / queryParams / headerParams / cookieParams,   // name, required, node
      request:  { present, required, fields: FieldNode[] },
      responses: { "200": { fields: FieldNode[] }, ... }
    }, ...
  ]
}

FieldNode = { path: "premium.breakdown[].amount", type, required, enum, format,
              deprecated, sunset, union, additionalPropertiesForbidden }
```

Why this shape exists:

- **`$ref`s are fully resolved first**, then schemas are flattened to field paths using
  `.` for nesting and `[]` for array items. Two files that describe the same contract
  flatten identically even if one uses `components` and the other inlines everything —
  so reorganisations produce (almost) no diff.
- **Endpoints are keyed by method + normalised route shape** (`GET /quotes/{}`), so
  renaming a path parameter (`{id}` → `{quoteId}`) is not a new endpoint. Route-shape
  identity is also what consumer usages match against.
- **Composition is flattened**: `allOf` merges branches (field required only if required
  in *every* branch, types union when they differ); `oneOf`/`anyOf` flatten to a union;
  reference cycles are cut with an `x-guard-cycle` marker (resolve depth 32, flatten
  depth 24) instead of hanging.
- **Array-root responses** (`GET /policies` returns `[Policy]`) produce item paths rooted
  at `[].` — e.g. `[].legacyCode` — which impact matching treats as the consumer's plain
  field names.

The flat model of every published version is stored in the DB (`versions.flat`), so
later diffs never re-parse the original YAML.

---

## 5. The publish pipeline walkthrough

Entry points: `POST /api/services/:slug/publish` (real) and
`POST /api/services/:slug/preview` (same analysis, records nothing).
Implementation: `guard/src/services/publish.js` + `guard/src/analyse.js`.

```
 candidate YAML
      │
      ▼
 ① parse        js-yaml (JSON schema mode). Empty/malformed/scalar → GuardError(parse)
      ▼
 ② validate     must be OpenAPI: "openapi" string, info.title/info.version,
                paths with at least one operation each → GuardError(validate)
      ▼
 ③ resolve      every internal $ref dereferenced; broken or external refs →
                GuardError(resolve) listing each broken ref
      ▼
 ④ flatten      → wire model (§4)
      ▼
 ⑤ diff         vs the *current published version's stored flat* (none for v1).
                Output: structural change objects (kind + location + direction),
                no opinions yet
      ▼
 ⑥ classify     each change gets exactly one severity + human note (§6)
      ▼
 ⑦ impact       registered consumer_usages matched per change (§7):
                change.affected[] = [{consumer, team, usage, via}],
                per-consumer findings rollup, unmatched usages detected
      ▼
 ⑧ verdict      any DANGEROUS → BLOCKED, else PUBLISHED_OK
                (counts per severity, affected consumers list)
      ▼
 ⑨ persist      single transaction:
                • attempt_no = max+1, attempt row written (with raw submitted YAML)
                • BLOCKED → nothing else happens
                • PUBLISHED → duplicate version check (409), insert into versions
                  (spec JSON + flat JSON + changes + counts + impact, revision=max+1),
                  services.current_version_id updated
      ▼
 ⑩ notify       POST {event, summary, counts, affected_consumers, ...} to WEBHOOK_URL;
                delivery outcome recorded in notifications table and attempt.notified set
```

**HTTP results**: `201` published · `409` blocked (attempt recorded) · `409` duplicate
version already registered · `422` refused with `{status:"ERROR", stage, error,
brokenRefs?|problems?}` when any of ①–③ fails (attempt recorded as ERROR with
`error_stage`/`error_message`) · `400` no spec body.

**Fail-safe policy**: stages that *cannot understand the spec* never publish. The
failure is visible in the API response, on the service page, in metrics ("failed
analyses") and via a `publish.failed` webhook. A retry after the fix (e.g. the kit's
claims v2 typo → v3) publishes cleanly against the still-current baseline.

**Preview** runs ①–⑧ only and returns `preview: true` with `would_be` (PUBLISHED or
BLOCKED) — used by both the service page's "Preview result" and the Diff page's
candidate-spec analyser. Nothing is recorded and no webhook is sent.

**Diffing any two published versions** (`GET /api/services/:slug/diff?from=A&to=B`)
skips ①–④ by loading both stored `flat`s, then runs ⑤–⑦ against *current* consumer
registrations. Used by the Diff page.

---

## 6. Severity policy (as encoded in `guard/src/lib/rules.js`)

Every structural change gets exactly one flag. Direction matters — *relaxing what the
server accepts is safe; tightening it is not. Adding to a response is safe; removing
from it is not.*

| Change | Request direction | Response direction |
| --- | --- | --- |
| Field added | optional → `SAFE`; required → `DANGEROUS` | `SAFE` |
| Field removed | required → `SAFE` (relaxation); optional → `WARNING` (strict providers may reject senders) | `DANGEROUS` |
| Required ⇄ optional | → required: `DANGEROUS`; → optional: `SAFE` | → optional: `WARNING` (no longer guaranteed); → required: `SAFE` |
| Type changed | `DANGEROUS` | `DANGEROUS` |
| Enum values removed | `DANGEROUS` (callers sending them rejected) | `WARNING` |
| Enum values added | `SAFE` | `WARNING` (exhaustive handlers) |
| Format changed | `WARNING` | `WARNING` |
| Unknown-field tolerance removed (`additionalProperties:false`) | `DANGEROUS` | `WARNING` |
| Deprecated now (`deprecated:true`, `x-sunset` honoured) | `DEPRECATED` — past dates called out in the note | same |
| New required param (path/query/header/cookie) | `DANGEROUS` | — |
| New optional param | `SAFE` | — |
| Param removed / requirement relaxed | `SAFE` (acceptance relaxed) | — |
| Path param renamed (same position) | `SAFE` (wire URL unchanged) | — |
| Endpoint added | `SAFE` (nobody depends on it yet) | — |
| Endpoint removed | `DANGEROUS` (all callers break) | — |
| Endpoint deprecated | `DEPRECATED` (sunset date if given) | — |
| Request body became required | `DANGEROUS` | — |
| Response status added | — | `SAFE` |
| Response status removed | — | `DANGEROUS` |

`SAFE` changes are listed in the changelog for completeness but contribute **no**
consumer findings and never block. `DEPRECATED` means nothing breaks today; the note
carries the sunset date (or "no removal date given") and flags already-past dates.

---

## 7. Impact analysis (as encoded in `guard/src/lib/impact.js`)

Input: the change list + all `consumer_usages` registered for the provider
(`consumer, team, method, path, sends[], reads[]`).

Matching rules (conservative):

1. **Endpoint attachment** — a usage applies to a change when the HTTP method matches
   (usage `ANY` matches everything) *and* the usage's normalised path equals the
   change's route shape. `/quotes/{id}` attaches to `/quotes/{quoteId}`.
2. **Side selection** — request-side changes compare against the usage's `sends`
   (plus the path parameters it must send); response-side changes against `reads`.
3. **Whole-endpoint changes** (endpoint removed/deprecated, status removed, body made
   required, new required param) affect *every* usage of that route.
4. **New required request field** affects every usage that does **not** already send
   that field or a child of it (`via: "does not send rider.ncbPercent"`).
5. **Removed/changed fields** affect usages that send/read the same field or any
   subtree of it (`sends premium.total` matches `premium`); `[].`-rooted response paths
   match the consumer's plain field paths.
6. **`SAFE` changes affect nobody** (empty `affected`, no findings).
7. **Unmatched usages** — declared routes that satisfy no endpoint of the current spec
   are surfaced separately as a data-quality signal (stale consumer file or route
   renamed/removed), not as an error.

Output per change: `affected[] = {consumer, team, usage, via}`; rollup per consumer of
distinct findings; `impact.unmatched[]`. This is what the UI shows under every finding
("affects …") and what metrics aggregates ("most affected consumers").

---

## 8. Dataflow journeys

**Boot** (`guard/src/index.js`)
1. `initSchema()` — idempotent DDL.
2. `seedIfEmpty()` (§11) — imports the kit if `services` is empty; never fatal.
3. `listen(:3000 inside container)`.

**Publish** — numbered steps in §5; the transaction guarantees attempt+version land
together or not at all; `current_version_id` only ever points at a fully analysed,
non-blocked version.

**Blocked publish retry** — the baseline for the next attempt is still the current
version (blocked specs never become the baseline). Example from the kit: quote-api
v2.1.0 attempted while v2.0.0 was blocked still diffs against current 1.1.0 and stays
blocked.

**Consumer registers usage** — `POST /api/consumers/:slug/usages` upserts on
(consumer, provider, method, path), replacing sends/reads. From then on, every publish
and every diff for that provider includes this usage in impact.

**Webhook** — every attempt outcome posts once: `publish.succeeded` / `publish.blocked`
/ `publish.failed` with `{service, from_version, to_version, attempt_id, status, counts,
affected_consumers, summary}`. Delivery failures never break the pipeline; they land in
the notifications table (visible on the Impact page) and the attempt stays marked
un-notified.

---

## 9. Data model (`guard/src/schema.sql`)

| table | holds | notes |
| --- | --- | --- |
| `services` | registered provider APIs | slug, name, owner_team, owner_contact, description, `current_version_id` |
| `consumers` | registered consuming services | slug, name, team, contact |
| `consumer_usages` | what a consumer calls of a provider | method, path template, `sends`/`reads` JSONB arrays, note; UNIQUE(consumer, provider, method, path), upsert semantics |
| `versions` | published versions only | version string, revision (per-service sequence), `spec` (parsed doc), `flat` (wire model), `changes`/`counts`/`impact` vs previous, attempt link; UNIQUE(service, version) |
| `publish_attempts` | the immutable changelog | attempt_no per service, from→to, status `PUBLISHED`/`BLOCKED`/`ERROR`, counts, changes, impact, `error_stage`/`error_message`, `raw` submitted YAML, `notified` |
| `notifications` | webhook delivery log | event, url, status_code, error, attempt link |

Blocked and failed specs are *not* in `versions` — the current version only ever moves
forward through a `PUBLISHED` attempt.

---

## 10. HTTP API reference

Base: `/api`. Bodies: JSON unless noted. Full handler map in `guard/src/routes.js`.

| Method & path | Purpose | Result |
| --- | --- | --- |
| `GET /health` | liveness + DB check + webhook config | `{ok, webhook}` |
| `GET /services` | list with current version, counts, last attempt | JSON |
| `POST /services` | register a provider | 201 · 409 duplicate · 400 invalid |
| `GET /services/:slug` | detail: service, versions, attempts, usages, current flat+spec | JSON |
| `POST /services/:slug/publish` | publish pipeline; body = raw YAML (`text/yaml`) or JSON `{yaml}` | 201 published · 409 blocked/duplicate · 422 refused (`stage`) |
| `POST /services/:slug/preview` | same analysis, records nothing | 200 with `would_be` |
| `GET /services/:slug/diff?from=A&to=B` | diff two published versions + current impact | 200 · 404 unknown version |
| `GET /services/:slug/versions` | version list | JSON |
| `GET /services/:slug/versions/:version` | one version incl. spec + flat + changes | 200 · 404 |
| `GET /services/:slug/attempts` | full attempt changelog | JSON |
| `GET /consumers` | consumers with their usages | JSON |
| `POST /consumers` | register a consumer | 201 · 409 · 400 |
| `POST /consumers/:slug/usages` | declare/upsert a usage `{provider, method, path, sends?, reads?, note?}` | 201 · 400/404 |
| `DELETE /usages/:id` | remove a usage | `{deleted}` · 404 |
| `GET /metrics` | totals, severity totals, affected-consumer ranking, per-service, recent attempts, unmatched usages | JSON |
| `GET /events` | last 30 webhook notifications | JSON |

Unknown routes and unexpected errors return JSON errors; a 500 always names itself as a
guard failure rather than a silent pass.

---

## 11. First-boot seed (`guard/src/seed.js`)

If `SEED_DIR` is set (compose sets `/kit`) and `services` is empty:

1. For each `specs/<service>/` dir (sorted): register the service (owner parsed from the
   spec description `Owner: X team`), then **publish the first version** through the real
   pipeline (no baseline → clean publish).
2. Register every `consumers/*.yaml` and upsert its usages — *before* later versions, so
   impact analysis has consumers when the interesting versions arrive.
3. Publish the remaining versions in file order through the same pipeline: attempted,
   classified, published or blocked exactly as a real submit would be.

Result with the kit data: 3 services, 4 consumers, 7 published versions, 12 attempts
(7 published / 4 blocked / 1 ERROR from the broken `$ref`), all seeded via webhook.

---

## 12. UI pages & navigation (`guard/src/ui/`)

Top nav (hash routes): **Services · Diff · Impact & Metrics · Consumers**; health badge
top-right; every list links into related pages.

**`#/` Services** — card per service: name, slug, owner/team, current version chip (or
"no version"), version count, consumer count, last attempt badge. Inline collapsible
form to register another service.

**`#/services/:slug` Service page** — the working page for an owner:
- header: name/slug, description, current version, owner block;
- **Publish a new version**: paste YAML or pick a file → *Preview result* (dry-run
  notice with verdict, counts, affected consumers, notification preview) or *Publish*
  (201/409/422 rendered as the same notice shape; parse/validate/resolve failures show
  the stage and the broken `$ref`s);
- **Current endpoints** table (method, path, `x-internal`/deprecated chips, summary,
  path params, query params);
- **Version history & changelog** — every published version with severity chips and an
  expandable grouped change list;
- **Publish attempts** — every attempt (PUBLISHED / BLOCKED / ERROR with stage), from →
  to, findings, when, affected consumers, notified ✓, expandable details;
- **Consumers of this API** — who calls what (method/path, sends, reads), plus a
  warning strip for unmatched usages.

**`#/diff` Diff** — service dropdown + from/to version pickers → grouped diff with
verdict badge, counts, affected consumers. Below: **candidate-spec analyser** — paste an
unregistered spec, preview what it would change against the service's current version.
Nothing is recorded.

**`#/impact` Impact & Metrics** — registry-wide stats: service/version/consumer/usage
totals, publishes allowed vs blocked vs failed, unmatched usages; severity-mix bar;
**most affected consumers** ranking; per-service table (current version, blocked
attempts, usages); recent attempts feed; unmatched usage table; webhook notification
log with delivery status.

**`#/consumers` Consumers** — register a consumer; declare a usage (provider, method,
path template, sends, reads as comma-separated paths); per-consumer tables of declared
usages with remove buttons.

---

## 13. Configuration & operations

Env vars (set in `docker-compose.yml`):

| var | default | meaning |
| --- | --- | --- |
| `PORT` | 3000 | API/UI listen port inside the container |
| `DATABASE_URL` | compose value | Postgres connection string |
| `WEBHOOK_URL` | '' (off) | where publish outcomes are POSTed; compose points it at the kit receiver |
| `SEED_DIR` | '' | kit folder with `specs/` + `consumers/` for first-boot import |
| `SEED_ON_BOOT` | 1 | set `0` to disable seeding |
| `GUARD_PORT` (host) | 9901 | host port mapping for Contract Guard |
| `WEBHOOK_PORT` (host) | 9900 | host port mapping for the receiver |

Commands:

```bash
docker compose up --build        # start everything
docker compose down -v           # stop and wipe the DB (next up re-seeds)
docker compose logs guard        # seed/publish log of what was accepted/blocked/refused

cd guard && npm test             # engine tests (no DB needed)
cd guard && GUARD_URL=http://localhost:9901 node --test test/e2e.test.js   # live-stack tests (write test data; reset afterwards)
```

Local dev without Docker: Node 20+, a Postgres, `DATABASE_URL` + `SEED_DIR` set, then
`npm start` in `guard/`.

---

## 14. Source map

```
guard/
  package.json, Dockerfile, .dockerignore
  src/
    index.js            boot: express app, static UI, schema init, seed, listen
    config.js           env parsing
    schema.sql          idempotent DDL (6 tables)
    db.js               pg pool, query(), withTx()
    lib/yaml.js         parse stage (GuardError on bad YAML)
    lib/errors.js       GuardError {stage, message, detail}, asGuardError
    lib/openapi.js      validateSpec (stage validate), resolveRefs (stage resolve)
    lib/flatten.js      wire model builder (§4)
    lib/diff.js         diffSpecs + changeLocation (change kinds, endpoint/param/field trees)
    lib/rules.js        classify → severity + note; summarise → counts
    lib/impact.js       computeImpact (§7)
    lib/pathutils.js    field-path helpers (ancestor pruning)
    analyse.js          pipeline orchestrator (①–⑧), humanSummary
    services/publish.js attempt lifecycle ⑨–⑩, preview, diffVersions, HttpError
    services/registry.js services/consumers/usages CRUD + metrics + events
    routes.js           REST API (§10) + JSON error mapping
    notify.js           webhook client + delivery log
    seed.js             first-boot kit import (§11)
    ui/                 index.html, style.css, app.js (hash-routed SPA)
  test/
    engine.test.js      15 tests: parse/validate/resolve failures, every kit scenario, matching
    e2e.test.js         11 tests against a running stack (publish/block/preview/register/metrics)
```

Kit inputs (read-only by rule): `specs/<service>/<n>-<name>.yaml` (OpenAPI 3.0.3, ordered
publish intent), `consumers/*.yaml` (usage declarations).

---

## 15. Design decisions & assumptions (candidate-owned, per PO answers)

1. **Wire-level comparison, not file-level.** $refs resolved; route shapes normalised;
   schemas flattened; reorganisations are a non-event (verified: kit quote v2 → exactly
   one SAFE `param_renamed`).
2. **Path params matched by position** → renames are SAFE cosmetic changes; the
   parameter *value* is what the caller sends.
3. **Integer vs number are distinct types** (a widening int→number is still flagged as
   `DANGEROUS` — safe default until told otherwise).
4. **Response enum widening is WARNING, not SAFE** — consumers with exhaustive handling
   (state machines) can misbehave even though nothing "rejects".
5. **Removing an optional request field is WARNING** — lenient providers ignore it, but
   providers that validate strictly would now reject senders; surfaced rather than
   assumed safe.
6. **SAFE additions don't propagate to consumers** — they're in the changelog, they
   contribute no findings (answers PO Q3).
7. **Fail safe everywhere** — unknown/unparseable/unresolvable → refuse + record +
   notify (answers PO Q4). Blocked ≠ deleted: full attempt history (answers PO Q5).
8. **One severity per change** with a deterministic note; changes sorted by endpoint,
   then severity, then path.
9. **Consumer registrations are trusted declarations**, matched conservatively; stale
   declarations are surfaced (unmatched usages) rather than auto-cleaned.
10. **Notifications are best-effort** — delivery problems never block the pipeline and
    are always visible in the UI.

---

## 16. Verification status (as built)

- `engine.test.js` 15/15: reorganisation fidelity; blocked quote v2→v3 (amount removal ×
  both endpoints + internal `region` param + EXPIRED enum warnings); retry-after-block;
  deprecations with past/future sunset notes; policy removals hitting `payments-svc`;
  endorsement narrowing hitting `partner-portal`; broken `$ref` refusal; same-version
  fixed re-publish; response-field optionalisation warning; route-shape consumer
  matching; first-version publish; external ref/parse/validate failures.
- `e2e.test.js` 11/11: health, UI served, seeded state, public diff, 422 fail-safe with
  stage, 409 block with current version unchanged, preview records nothing, publish +
  duplicate refusal, registration flows, metrics aggregation.
- Seed replay through the real pipeline produces the expected verdicts per kit version
  (see `docker compose logs guard` after a fresh `up`).

Known limits (documented, not hidden): params in locations other than
path/query/header/cookie are skipped by the flattener; `not.requestBody`-only content
types fall back to the first media type's schema; usage declarations have no "last
verified" lifecycle yet; auth/multi-tenancy are out of scope for this stage.
