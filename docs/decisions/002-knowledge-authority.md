# ADR-002: Shared discovery with separate authority

Status: proposed, 2026-09-23.

## Context

Agents need platform documentation, mission memory and project evidence in one
usable library. Mixing all text into an undifferentiated memory pool would erase
the difference between an observation, a proposed design and an execution rule.

## Decision proposed

Build versioned knowledge with stable IDs, immutable revisions, source bindings,
namespace access and explicit lifecycle status. Import approved platform Markdown
as a read-only projection; preserve its canonical repository source. Keep
relational links and a replaceable search adapter. Compare QMD, a minimal FTS5
baseline and Basic Memory as specified in the [integration design](../designs/02-knowledge.md)
before selecting the retrieval implementation. Enforce authority in application
policy, independently of text or agent-authored metadata.

## Alternatives and consequences

Separate disconnected libraries would hinder understanding and handoffs. A single
writable wiki would blur ownership and make accidental policy changes likely.
Vector-only memory would not provide version conflicts, durable citations or
permission enforcement.

The shared library needs authorized retrieval and an importer. It also needs a
clear distinction between source authority, factual confidence and approval state.
These are explicit contracts, not properties supplied by the search engine.

## Revisit when

Retrieval evaluation demonstrates a need for semantic ranking, or a new access
model requires finer boundaries. See [knowledge design](../KNOWLEDGE.md) and
[source catalog](../catalog.json).
