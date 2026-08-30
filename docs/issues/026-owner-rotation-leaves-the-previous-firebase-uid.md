---
id: 26
title: Owner rotation leaves the previous Firebase UID authorized
status: resolved
symptom: After pinest-auth changes accounts, the old user can still connect to and control every session
state_items: S1,S6
tags: security,authorization,tenant-isolation
created: 2026-08-30
updated: 2026-08-30
---

Root cause: bootstrap captures the original UID in the WebSocket server, supervisor, heartbeat, and shutdown closures. Reauthentication only updates display globals and publishes one new presence document; it does not close old sockets or atomically rebind the remote stack. Required proof: an account-rotation adversarial test must show the old UID and sockets denied, old presence offline, new UID accepted, and all later heartbeats/restarts using only the new UID.

### Resolution (2026-08-30)
Same-UID reauthentication is enforced, prior sockets are closed, presence reads current owner state, and foreign owner rotation is refused; adversarial runtime tests pass.
