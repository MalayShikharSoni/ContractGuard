# Contract Guard

API contract registry. Teams publish each version of their API's OpenAPI specification;
Contract Guard diffs every new version against the currently published one, classifies each
change (`DANGEROUS` / `WARNING` / `DEPRECATED` / `SAFE`), checks every registered consumer
service for impact, and **stops the publish when a dangerous change is found** — while
keeping a permanent, browsable record of every attempt.

```
docker compose up --build        # from the kit root (one level up)
```

Then open **http://localhost:9901** (the webhook receiver stand-in is on :9900).

On first boot the app imports the kit's `specs/` and `consumers/` folders: every spec
version is replayed through the real publish pipeline, so versions, attempts, verdicts
and webhook notifications all exist out of the box. (`SEED_ON_BOOT=0` disables this.)

## How it decides

Every structural change gets exactly one flag. Direction matters:

| Change | Request direction | Response direction |
| --- | --- | --- |
| Field added | optional → `SAFE`, required → `DANGEROUS` | `SAFE` |
| Field removed | required → `SAFE` (relaxation), optional → `WARNING` | `DANGEROUS` |
| Requirement relaxed | `SAFE` | `WARNING` (no longer guaranteed) |
| Type changed | `DANGEROUS` | `DANGEROUS` |
| Enum values dropped | `DANGEROUS` (callers sending them rejected) | `WARNING` |
| Enum values added | `SAFE` | `WARNING` (exhaustive handlers) |
| Deprecated (`x-sunset` honoured) | `DEPRECATED` | `DEPRECATED` |
| New required param | `DANGEROUS` | — |
| Endpoint removed | `DANGEROUS` | — |
| Response status removed | — | `DANGEROUS` |

A publish with any `DANGEROUS` change is refused (`409`) and recorded as `BLOCKED`.
An analysis error (bad YAML, missing `info.version`, broken `$ref`, …) is refused
(`422`, fail safe — the guard never passes a spec it could not fully verify) and
recorded as `ERROR` with the failing stage. `SAFE` publishes become the current version.

The comparison is **wire-level, not file-level**: `$ref`s are resolved, schemas are
flattened to field paths (`premium.breakdown[].amount`), endpoints are keyed by
method + normalised route (`GET /quotes/{}`), so renaming components, inlining schemas
or renaming a path parameter produces no phantom diffs. All-of merges branches;
one-of/any-of flatten to unions; reference cycles are cut, not spun on.

## Impact analysis

Consumers register what they call: method + path template, `sends` (request fields and
parameters) and `reads` (response fields), using `.` for nesting and `[]` for array
items. Impact matching is conservative:

- usages attach to endpoints by method + normalised route, so `/quotes/{id}` still
  matches when the provider renames the parameter to `/quotes/{quoteId}`;
- a new required request field affects every usage of that endpoint that does not
  already send it (or a child of it);
- removed/changed fields affect usages that send/read the same field or any subtree;
- endpoint/status removals affect every usage of that route;
- `x-internal` endpoints are diffed but normally match no consumer registrations;
- usages that match no current endpoint are surfaced as "unmatched" (data-quality signal).

## HTTP API

```
GET    /api/health
GET    /api/services                      list + current version + last attempt
POST   /api/services                      {slug, name, owner_team, owner_contact?, description?}
GET    /api/services/:slug                detail: versions, attempts, usages, current flat
POST   /api/services/:slug/preview        body = YAML (or JSON {yaml})  -> dry-run analysis, records nothing
POST   /api/services/:slug/publish        body = YAML (or JSON {yaml})  -> 201 published / 409 blocked / 422 refused
GET    /api/services/:slug/diff?from=A&to=B
GET    /api/services/:slug/versions
GET    /api/services/:slug/versions/:version
GET    /api/services/:slug/attempts       full changelog of publish attempts
GET    /api/consumers
POST   /api/consumers                     {slug, name, team, contact?}
POST   /api/consumers/:slug/usages        {provider, method, path, sends?, reads?, note?}
DELETE /api/usages/:id
GET    /api/metrics                       totals, severity mix, affected consumers, per service, unmatched usages
GET    /api/events                        webhook notification log
```

## UI pages

- **Services** — all APIs, owners, current versions, last attempt status; register new services.
- **Service page** — publish (paste or upload YAML, with preview), current endpoints,
  version history with per-version changelog, every publish attempt with verdict and
  affected consumers, consumers of this API.
- **Diff** — pick any two versions of a service, or analyse an unregistered candidate
  spec; grouped findings with severities and impact.
- **Impact & Metrics** — registry-wide totals, severity mix, most-affected consumers,
  per-service table, recent attempts, unmatched usages, webhook delivery log.
- **Consumers** — register consumers and declare/edit usages.

## Notifications

Every publish outcome (`publish.succeeded`, `publish.blocked`, `publish.failed`) is
POSTed to `WEBHOOK_URL` (the kit's receiver stands in for chat/email) with a
human-readable summary, counts and affected consumers. Delivery problems never break
the pipeline; they are logged in the notifications table and shown in the UI.

## Tests

```
cd guard
npm test                  # engine tests: parse/resolve/flatten/diff/impact against the kit's real specs (no DB)
npm run test:engine       # same thing
node --test test/e2e.test.js   # against a running stack (GUARD_URL to override target); writes test data
```

## Layout

```
guard/
  src/
    lib/         yaml.ts-equivalents: parse, validate, resolve refs, flatten to wire model,
                 diff, severity rules, impact matching
    analyse.js   the pipeline: parse -> validate -> resolve -> flatten -> diff -> classify -> impact
    services/    publish.js (attempt lifecycle), registry.js (services/consumers/usages/metrics)
    routes.js    REST API
    ui/          static SPA (no build step)
    schema.sql   services, consumers, consumer_usages, versions, publish_attempts, notifications
    seed.js      first-boot kit import
  test/          engine tests (pure) + e2e tests (live server)
```

Notes: local dev without Docker needs Node 20+ and `DATABASE_URL` pointing at a Postgres
with the schema (created automatically on boot). Specs/consumers folders are read-only
inputs — the registry stores what was published.
