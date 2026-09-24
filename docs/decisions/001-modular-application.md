# ADR-001: One application with explicit module boundaries

Status: proposed, 2026-09-23.

## Context

The personal prototype has useful harness, transport and service boundaries but
mixes many state transitions in a generic store and large service switch. The
observed risks are consistency, context growth and recovery. No measured workload
currently requires distributed domain services.

## Decision proposed

Keep TypeScript, SQLite, Discord and the Claude Code harness adapter. Refactor
incrementally into typed domain/application modules, concrete repositories and
explicit transactions. Preserve external tool contracts through adapters. Isolate
generated-code execution where required by its trust boundary; keep domain
modules in one deployable application initially.

## Alternatives and consequences

A wholesale rewrite would delay learning from live missions and discard working
interfaces. Immediate microservices would add distributed failure modes before
local state semantics are sound. Leaving the current generic store unchanged
would make histories and transactional invariants harder to manage.

This choice requires real module ownership and query boundaries; moving files
alone is insufficient. A single supervisor remains a deployment constraint.

## Revisit when

Measured write contention, independent worker hosts, hosted tenancy or separate
deployment needs justify additional infrastructure. See [HLA](../HLA.md) and
[implementation plan](../PLAN.md).
