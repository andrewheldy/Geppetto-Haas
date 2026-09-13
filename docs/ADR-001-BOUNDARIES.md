# ADR-001 — System Boundaries

Status: Proposed

## Decision

HeldyOS will treat Ruflo as a runtime dependency behind an adapter rather than as the canonical orchestration/state model.

## Rationale

We want to reuse:
- swarm execution
- hooks
- runtime coordination
- federation primitives
- memory / trajectory learning where useful

while preserving independent ownership of:
- HSC state
- agent manifests
- harness manifests
- routing policy
- evaluation data
- promotion rules

## Consequence

No core HeldyOS object may expose a Ruflo-specific type.

Runtime translation happens at the boundary.

## Canonical Direction

```text
HeldyOS manifests → RuntimeAdapter → Ruflo
Ruflo trace → RuntimeAdapter → HeldyOS ExecutionTrace
```
