---
id: 43
title: agent_service.dart exceeds the 1200-line structure cap
status: resolved
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

### Note (2026-09-14)
Resolved: agent_service.dart is 1173 lines after extracting history_merge.dart, the endpoint validators, and server_http.dart (9 new tests). The composition root was extracted too (direct-transport.ts, session-lifecycle.ts, pi-context-queries.ts): index.ts 1310 -> 1158. tools/check_structure.py passes.

### Resolution (2026-09-14)
agent_service.dart 1350 -> 1173 lines; index.ts 1310 -> 1158. npm test structure check passes; flutter analyze clean; 11 new tests (9 server_http + 2 verifier mask).

### Note (2026-09-14)
Second pass: agent_service.dart 1205 -> 1168 by extracting DirectLink (answer-the-offer state machine, 7 tests). Structure check passes.
