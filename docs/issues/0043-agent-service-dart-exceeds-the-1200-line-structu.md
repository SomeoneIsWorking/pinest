---
id: 43
title: agent_service.dart exceeds the 1200-line structure cap
status: open
symptom: npm test stops at the structure check: app/lib/services/agent_service.dart is 1288 lines (limit 1200)
tags: structure,p1,quality
created: 2026-09-14
updated: 2026-09-14
---

## Priority
P1 - the repository's own gate is red, so every other change lands on a failing gate.

## Cause
The file mixed transport (HTTP client), outbox/replay, image fetching, transcript assembly, and session state. The earlier ServerHttp extraction was reverted after a mis-sliced edit duplicated a block; it must be redone as small exact-string moves, verifying analyze+tests after each.

## Done when
Transport (HTTP base/key/requests) is its own module with tests, agent_service.dart is under the cap, and the whole suite is green.
