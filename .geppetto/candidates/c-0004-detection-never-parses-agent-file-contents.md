---
id: c-0004
status: pending
op: add
target: decisions.md
heading: "D-004: Detection is by path, not by content"
base: absent
content_hash: 51d5f631c5b8
run: r-0001
task: Improve adapter detection
created: 2026-09-24
---

# Detection never parses agent file contents

## Why

parsing instruction files would guess at semantics; importing them as candidates leaves judgement to a human

## Proposed content

Status: proposed · Date: 2026-09-24
Agent detection matches known paths only and reads a file only to import it verbatim (headings demoted) as a candidate. Geppetto does not interpret instruction-file semantics.
