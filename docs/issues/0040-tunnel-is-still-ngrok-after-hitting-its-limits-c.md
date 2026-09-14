---
id: 40
title: Tunnel is still ngrok after hitting its limits (cloudflared installed, never verified)
status: open
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
