Graceful handling here comes in two kinds. One is when the checking system itself fails or lacks information. The other is when a breaking change is real and has to happen anyway. The principle behind both: never let “couldn’t check” look the same as “checked and it’s fine.”

When the checker itself fails

Keep “check errored” separate from “check found a break.” An invalid spec, an unresolved $ref, a missing import or a parser crash should produce its own error state with a clear message. If it shows up as a pass, broken specs slip through. If it shows up as a finding, people learn to ignore findings.
Choose fail-closed or fail-open on purpose, per stage. If the registry or broker is unreachable during a can-i-deploy check, most teams fail closed for production (block the deploy) and fail open in dev and staging (allow it with a loud warning). Either way, use retries and timeouts so a temporary outage doesn’t block every deploy.
“No baseline” is a valid state. For a brand-new API or a first schema version, everything counts as added, so it passes. Don’t treat it as an error.
Pin the checker’s version. Upgrading the tool can add or change rules, so a contract that passed yesterday fails today with no code change. Upgrade deliberately, not as a side effect.

When information is missing or stale

Unknown consumers are not the same as no consumers. If a consumer hasn’t published contracts, or its contracts are stale, “breaking, but no known consumers” is a weak claim. Mark it as unknown rather than safe.
Bring in new consumer expectations gradually. Pact’s “pending pacts” feature lets a new or changed consumer contract run against the provider without failing the provider’s build until it has passed verification once. Without that, a consumer team could block a provider’s release just by publishing new expectations.
Contract drift. The published spec can say one thing while the running service does another, and then every rule is checking fiction. The usual safeguards are generating the spec from code, validating real responses against the spec, or having the provider verify itself against the real implementation, which is what Pact does.

When a break is real and intended

Use a scoped, recorded escape hatch, not “turn checking off.” Suppress one rule at one location, with a reason, an owner and ideally an expiry date. Changes that are actually breaking should also need a version bump or approval from the affected consumers.
Emergency hotfixes get break-glass. Allow the override, log who used it and why, and require a follow-up. That way the rules don’t get weakened permanently just to get through one incident.
The safest break happens in stages: expand, migrate, contract. First add the new field or endpoint next to the old one, which is additive and safe. Then move consumers over, tracking it through deprecation flags and usage data. Remove the old one only when usage reaches zero. With this pattern, many changes never need to be classified as breaking at all.

At runtime (reduces how much is breaking at all)

Tolerant consumers shrink the “potentially breaking” category. Consumers can ignore unknown fields, map unknown enum values to a fallback such as UNKNOWN, and treat missing optional fields as defaults. The more of this consumers do, the more response-side changes are safe in practice. It doesn’t make the checker’s warnings unnecessary, though, because you can’t assume every consumer does it.

tell me more about the deprecation severity that you were talking about

Deprecation differs from the other flags because it describes a change over time rather than an immediate effect. Marking something deprecated breaks nothing today. It announces that the element will be removed later, and it starts a clock. A deprecation flag has two jobs: allow the eventual removal to go through without being treated as an accident, and make sure consumers know about it in time.

How deprecation is marked in contracts

OpenAPI: deprecated: true on an operation, parameter or schema property. Sunset dates aren’t part of the core spec, so tools use extensions. oasdiff reads x-sunset.
Protobuf: [deprecated = true] on fields, messages or enums. Code generators turn this into language-level annotations such as Java’s @Deprecated, so consumers see warnings in their IDE and compiler, not just in the registry.
GraphQL: @deprecated(reason: "...") is built into the language, and introspection exposes it.
Over HTTP at runtime: the Sunset header (RFC 8594) gives the removal date, and the Deprecation header (RFC 9745) says the endpoint is deprecated. These reach consumers who never read the spec.

How it changes classification

Adding a deprecation marker is a metadata-only change. It counts as informational or deprecation-level and is never breaking.
Removing an element that was never deprecated gets the strongest flag. oasdiff has checks along the lines of “path removed without deprecation.”
Removing a deprecated element before its sunset date is still treated as breaking or blocked.
Removing it after the sunset date is downgraded and allowed. This is the payoff: the deprecation history turns a removal from “breaking” into “scheduled.”
Windows can depend on stability. oasdiff, for example, lets you set different minimum deprecation periods for beta and stable APIs. Short windows suit beta, and long ones suit stable or public APIs.

What makes a deprecation useful rather than decorative

A replacement. “Use v2/orders / field amount_minor instead.” Without one, consumers can’t act on the deprecation.
A date. A deprecation without a sunset date tends to last forever, and everyone learns to ignore the flag.
Usage tracking. Consumer contracts or traffic telemetry show who still calls or reads the element. This is what decides whether removal is safe when the date arrives. “The date has passed” and “nobody uses it anymore” are separate conditions, and mature setups require both.
Notifying the right people. The registry knows the owner of each consumer contract, so it can alert those teams directly instead of hoping they read a changelog.

Common failure modes

Deprecations pile up with no dates, so the flag carries no information.
The date passes while consumers are still active, and the provider removes the element anyway. Respecting the date over the usage data turns a planned removal into an outage.
Deprecation is marked only in the spec. Consumers who never regenerate clients or read docs never find out. Runtime headers and compiler warnings exist to fix exactly this.

This is the flag that drives the expand, migrate, contract pattern from earlier. Expand is additive, migrate happens while the old element is deprecated, and contract is the removal after sunset that the checker now allows.

an example of such case pleease

Here’s one worked example: replacing a field in a response, with three consuming teams.

Setup. The Orders API returns amount: 499.99, a float in rupees. The provider wants to switch to amount_minor: 49999, an integer in paise, plus currency, because floats round money badly. The teams that consume this are Billing, Notifications and Analytics.

Stage 1: Expand (Dec 2026). Add the new fields alongside the old one, and deprecate the old one in the same release:

yaml
amount:
  type: number
  deprecated: true
  x-sunset: "2027-03-01"
  description: Use amount_minor + currency instead.
amount_minor: { type: integer }
currency:     { type: string }
The checker reports “response property added” twice, which is informational or potentially breaking for strict deserializers. It also reports “property deprecated,” which is deprecation-level. Nothing blocks.
At runtime, responses start carrying Deprecation: @1796083200 (1 Dec 2026) and Sunset: Mon, 01 Mar 2027 00:00:00 GMT.
The registry notifies the three teams whose consumer contracts reference amount.

Stage 2: Migrate (Dec–Feb). Usage tracking shows the progress:

Billing switched in December, and its contract no longer mentions amount.
Notifications switched in January.
Analytics is still reading amount.

Stage 3: Someone tries to remove the field early (Feb 2027). Removing a deprecated property before its sunset date is flagged as breaking, so the PR is blocked. The fix is to wait.

Stage 4: The date passes, but a consumer hasn’t moved (2 Mar 2027). This is the failure mode from earlier.

Date check: passes, because the sunset date has gone by.
Usage check: fails, because Analytics’ contract still reads amount. can-i-deploy returns no for the provider version without the field.
The removal stays blocked. A setup that checked only the date would ship it here and break Analytics’ dashboards, probably silently: a missing float might show up as nulls or zeros instead of a crash. The right move now is to contact the Analytics team or agree on a short extension, not to force the removal.

Stage 5: Contract (mid-March 2027). Analytics migrates and publishes a contract without amount.

The removal now passes both checks. The field was deprecated, its sunset date has passed, and no consumer reads it.
The checker reports “deprecated property removed after sunset,” which is allowed at informational level. The same diff would have been flagged as a hard break back in Stage 3.

The structural change in Stage 5 and Stage 3 is identical: one property removed. The severity differs only because of the deprecation history and the usage data around it.

with what stages do these pipelines usually work in these kinds of systems?

They usually run in stages that follow a change from the developer’s machine to production. The early stages are fast and conservative, using static rules against the schema alone. The later ones are slower but more accurate, using real consumers and real deployments. Each stage also compares against a different baseline, and that turns out to matter.

Authoring (local). Linting and a quick breaking check in the editor or as a pre-commit hook, for example buf lint / buf breaking, or Spectral for OpenAPI. The baseline is your local main branch. The point is to catch obvious mistakes before anyone else sees them.
Pull request (CI). A full static diff against the target branch, with findings posted as PR comments and gated by severity. Breaking blocks the merge, warnings need acknowledgment, and info is just shown. On the consumer side, the consumer’s tests run here and generate its contract, the record of what it actually uses. The baseline is the main branch.
Publish to the registry (on merge). The contract is stored with a version, usually the git SHA plus a branch or tag. For event schemas, the registry runs its own compatibility check at registration and rejects incompatible schemas. Teams often run that check earlier in CI too, for example with Confluent’s Maven plugin goal test-compatibility. When a consumer publishes a new or changed contract, a webhook triggers verification on the provider’s side.
Provider verification. The provider’s CI pulls the relevant consumer contracts and replays them against the real running implementation, not the spec. “Relevant” usually means contracts from consumers’ main branches plus whatever consumer versions are currently deployed. The results are published back to the registry. This stage also catches the drift between the spec and actual behavior that static diffing misses.
Pre-deploy gate. Before deploying to a given environment, the pipeline asks whether this version is compatible with everything currently running there (can-i-deploy in Pact). The baseline is now the deployed versions, not main. A provider can be compatible with the consumer’s latest code and still break the older consumer version actually running in production.
Record the deployment. After a successful deploy, the pipeline tells the registry which version is now in which environment (record-deployment / record-release in Pact). Skipping this step quietly ruins stage 5 later, because the registry ends up checking against stale information about what’s deployed.
Runtime. Deprecation and Sunset headers go out in responses. Usage telemetry tracks who still calls deprecated elements, and some teams validate sampled real traffic against the spec. This is where the usage data used to downgrade a flag (for example, “breaking, but no live consumers”) comes from.
Retirement. At the sunset date, the removal goes back through stages 2–5. It passes only if both conditions hold: the date has passed and no consumer still uses the element. That’s the Stage 5 removal from the earlier example.

A failure at any stage should report which stage failed and why: a rule fired, verification failed, or the registry was unreachable. That separates “the checker couldn’t run” from “the checker found a problem,” as covered earlier.