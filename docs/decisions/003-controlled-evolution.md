# ADR-003: Develop freely; activate through a controlled release path

Status: proposed, 2026-09-23.

## Context

Useful autonomy includes changing world configuration and building better tools.
An agent that can also replace its permission enforcement, audit history or budget
has no meaningful operating boundary. Hiding all platform code would unnecessarily
limit understanding and improvement proposals.

## Decision proposed

Separate platform, project and extension ownership. Share curated documentation
and source snapshots. Allow project work and bounded declarative world changes
under existing policy. Stage executable extensions with enforced capabilities,
protected checks, immutable candidates and rollback. Route platform changes
through a maintainer release path. Keep credentials and activation authority
outside agent-controlled execution.

## Alternatives and consequences

An immutable black-box world would restrict useful adaptation. Unrestricted
self-editing of the live platform would allow mistakes to disable supervision.
Requiring approval for every reversible data change would obstruct useful work.

This design needs a real worker boundary and a release controller as capabilities
expand. Separate repositories improve ownership but are not sandboxing. Approval
is needed for new authority, not for each action already covered by a bounded grant.

## Revisit when

A real extension requires a capability that cannot be expressed safely, or
operational evidence suggests adjusting preapproved limits. See
[evolution design](../EVOLUTION.md).
