# Routing authority boundary

Production dispatch and recovery remain owned by `LegacyProductionRouter`, which
delegates to the existing optimizer without changing its inputs or policy.
`ContextualRouterVNext` independently produces `SELECTED` or `ABSTAIN` from a
validated canonical evidence artifact. Its input contains model identity,
compatibility and measured economics, not legacy quality configuration.

The shadow adapter extracts raw capability/context/price facts and separately
builds the canonical task. It does not pass specialist estimates, configured
quality priors, tier labels, legacy reference scores or fallback rankings to
VNext. Missing measured latency remains unavailable; configured latency priors
are not substituted. Missing or inadequate quality evidence remains `ABSTAIN`.

Historical outcomes can enter through `adaptHistoricalQualityOutcome`. This
adapter preserves actual usage and identity, requires independent
requirement-level proof for positive evidence, admits only attributed model
failures as negative evidence, and censors operational and synthetic outcomes.
It does not import historical quality predictions or ranking. This change does
not automatically migrate or write production history.

`authoritativeRoutingDecision` defines an explicit future authority switch.
Legacy/shadow selects only the legacy decision; contextual authority selects
only the contextual decision, including abstention. This is a tested migration
seam, not a production activation setting. Production remains legacy.

`tests/routerAuthority.test.ts` checks the complete production selection with
shadow on/off, unchanged history bytes, poisoned legacy-quality fields,
canonical-only history normalization, artifact validation, a transitive runtime
dependency audit, and explicit authority selection without fallback.

This boundary does not complete the broader contextual-routing milestone:
rich public dataset ingestion, direct paired-regret inference, measured verifier
calibration and the native calibration belt still require implementation and
validation. No paid model calls or router activation are part of this change.
