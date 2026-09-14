---
id: 48
title: Every send from the phone failed: the HTTP route dispatched the command envelope
status: resolved
tags: protocol,http,client,p1,root-cause
created: 2026-09-14
updated: 2026-09-14
---

Live evidence: the phone showed 'unsupported command type "command"' and no message arrived; a probe against the running host showed HTTP 202 for every posted body, including bodies the router refused.

Three defects, one wire shape between them:
1. serveMessage built {type:'command',cmd:{...}} and handed it to a sink that expects a command, so the validator saw type 'command'.
2. The socket unwrapped the frame and the HTTP route did not, so one command was built two ways; the old test asserted the envelope, which is why it survived.
3. The route answered 202 for a command the router REFUSED, because dispatch pointed at the socket's handler, which catches refusals and pushes them as notices.

Fixed in 20087a3 / 390af6c: {type:'command',cmd:{...}} is the frame on every transport, built by commandFrame on the client and read by commandFromFrame on the machine (one conversion, concrete ClientCommand, no casts); a body that is not a frame is a 400 by name; a well-formed command the machine refuses is a 409 naming the reason; and both transports are pinned to each other by a test asserting they produce deeply equal commands. tools/verify_live_host.py reproduces a phone's requests against the running host over loopback and the public tunnel name, and showed the failure before the fix landed.

### Resolution (2026-09-14)
Fixed and pinned by server/test/http-api.test.ts, server/test/wsserver.test.ts (differential: both transports produce the same command), app/test/server_http_test.dart (the app sends the frame), and tools/verify_live_host.py for the live process.
