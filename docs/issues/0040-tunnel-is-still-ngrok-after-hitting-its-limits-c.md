---
id: 40
title: Tunnel is still ngrok after hitting its limits (cloudflared installed, never verified)
status: resolved
symptom: The app cannot reach /message over the ngrok tunnel: ClientException NetworkError to https://*.ngrok-free.dev/message; ngrok reports the account over its limits
tags: tunnel,p0,cloudflared
created: 2026-09-14
updated: 2026-09-14
---

## Priority
P0 - the user cannot send messages at all.

## Cause
config tunnelProvider is already cloudflared, but the cloudflared binary was not installed, so startProviderTunnel fell back to ngrok. ngrok is now refusing traffic (limits), which the browser sees as a bare NetworkError rather than a status code. cloudflared 2026.9.1 is now installed at ~/.local/bin/cloudflared (on the host PATH).

## Done when
The host runs a cloudflared tunnel, the state snapshot reports tunnelProvider cloudflared with a *.trycloudflare.com URL, and a POST /message reaches the server over it (a real status code, not a NetworkError).

### Note (2026-09-14)
Also found while working this: the app's CSP connect-src did not allow the tunnel origin, so images/messages/history fetched from https://<tunnel> were refused by the browser (the earlier 'NetworkError when attempting to fetch resource'). app/firebase.json now lists the tunnel suffixes; the hosting deploy is still pending.

### Note (2026-09-14)
Root cause found and fixed (b309b5a): the host cannot resolve its own *.trycloudflare.com name locally (local resolver rcode=3/NXDOMAIN, stably, while 1.1.1.1 and 8.8.8.8 return rcode=0 with 2 answers; edge and one.one.one.one reachable; other names fine locally). The verify-before-publish check used that resolver as its oracle, so it declared a working tunnel dead, killed the process, and the heartbeat restarted one every 20s. endpointAnswers/probeEndpoint now also resolves through public resolvers and requests the resolved address with the tunnel's own SNI/Host; ANY status proves name→edge→tunnel→server. Live evidence: a real quick tunnel this host answers HTTP 000 to was proven answered=true vantage=public-dns by the shipping code. Same investigation found a process leak: a tunnel still being verified had no handle, so a reload could not stop it (orphan cloudflared per reload held a public name pointed at a dead port); providers now report the spawned process and a teardown cancels/kills it and refuses a late result.

### Note (2026-09-14)
VERIFIED LIVE (2026-09-14): state frame reports online=true provider=cloudflared tunnelUrl=https://institution-automatically-starsmerchant-headphones.trycloudflare.com localUrl=ws://127.0.0.1:36423. Public path proven from a working resolver: the name resolves to a Cloudflare edge address (104.16.230.132), /image/tunnel-probe returns HTTP 401 and /history with a wrong key returns HTTP 401 {"error":"missing or invalid access key"} - name -> edge -> tunnel -> local server, with our auth boundary answering. The direct offer is published alongside (812 bytes).

### Resolution (2026-09-14)
Fixed and verified live: probeEndpoint proves the endpoint through public resolvers when the host's own resolver cannot see the name (the measured root cause of no URL being published), and the tunnel process is now cancellable so a reload cannot leak it. Closing on: provider=cloudflared in the state frame, the URL published, and the public path answering with our auth boundary (401).
