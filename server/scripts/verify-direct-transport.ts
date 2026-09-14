/**
 * Live verification of the direct (no-tunnel) transport, against a RUNNING host.
 *
 * Why this exists: the unit tests prove the policy and the local bridge, and the
 * browser tests prove the app's side, but neither answers the question that
 * actually matters in production - does a second peer, signaling through the
 * real discovery document under the deployed rules, get a DataChannel to THIS
 * machine and speak the real protocol over it? Without a second device on
 * another network this is the closest faithful run available, and it is the one
 * that catches a perishable offer: a stale NAT mapping and a fresh one look
 * identical in the document.
 *
 * What it does NOT prove, and says so: NAT traversal from a third network. Both
 * peers run on this machine, so ICE can succeed on a local candidate. The
 * remaining evidence is a real phone, and the script prints the offer age it
 * answered so a punch that only worked locally is visible as such.
 *
 * Credentials come from the host's own cached owner refresh token; nothing
 * secret is printed. Exit code is 0 only when a frame crossed the channel.
 *
 * Usage:
 *   node server/scripts/verify-direct-transport.ts [--timeout-ms 60000]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RTCPeerConnection, RTCSessionDescription } from "werift";

const PROJECT = "pinest-app";
const AUTH_PATH = join(homedir(), ".pi", "agent", "remote-code", "auth.json");

class VerificationError extends Error {}

/** The Firebase web apiKey: a public value the app embeds, which the repository
 * deliberately does not carry. Resolved under the SAME variable name the server
 * uses (`server/src/auth.ts`), falling back to the same `firebase apps:sdkconfig`
 * route `app/deploy.sh` uses, and refusing by name when neither is available. */
const WEB_APP_ID = "1:271491621267:web:3822b177db9e36a57b8866";

function webApiKey(): string {
  const fromEnv = process.env.RC_FIREBASE_API_KEY;
  if (fromEnv) return fromEnv;
  try {
    const sdkConfig = execFileSync(
      "firebase",
      ["apps:sdkconfig", "WEB", WEB_APP_ID, "-P", PROJECT],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const match = /"apiKey":\s*"([^"]+)"/.exec(sdkConfig);
    if (match?.[1]) return match[1];
  } catch {
    // Falls through to the refusal below, which names both routes.
  }
  throw new VerificationError(
    "no Firebase web apiKey: set RC_FIREBASE_API_KEY, or make the `firebase` CLI "
    + `available so \`firebase apps:sdkconfig WEB ${WEB_APP_ID} -P ${PROJECT}\` can resolve it`,
  );
}

function argValue(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new VerificationError(`${name} needs a positive number of milliseconds`);
  }
  return value;
}

/** The host's cached owner credentials, refused by name when absent. */
function ownerRefreshToken(): string {
  let parsed: { refreshToken?: unknown };
  try {
    parsed = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  } catch (error) {
    throw new VerificationError(
      `cannot read the host's credentials at ${AUTH_PATH} (${(error as Error).message}); `
      + "sign in from the app (or run /pinest-auth) before verifying the direct transport",
    );
  }
  const token = parsed.refreshToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new VerificationError(`${AUTH_PATH} has no refreshToken; sign in again from the app`);
  }
  return token;
}

async function ownerIdToken(
  refreshToken: string,
  timeoutMs: number,
): Promise<{ idToken: string; uid: string }> {
  const response = await fetchBounded(`https://securetoken.googleapis.com/v1/token?key=${webApiKey()}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  }, timeoutMs);
  if (!response.ok) {
    throw new VerificationError(`owner token refresh failed: HTTP ${response.status}`);
  }
  const body = await response.json() as { id_token?: string; user_id?: string };
  if (!body.id_token || !body.user_id) {
    throw new VerificationError("owner token refresh returned no token");
  }
  return { idToken: body.id_token, uid: body.user_id };
}

function docUrl(uid: string): string {
  return `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/users/${uid}`;
}

async function readDoc(
  uid: string,
  token: string,
  timeoutMs: number,
): Promise<Record<string, any>> {
  const response = await fetchBounded(
    docUrl(uid),
    { headers: { Authorization: `Bearer ${token}` } },
    timeoutMs,
  );
  if (!response.ok) throw new VerificationError(`discovery read failed: HTTP ${response.status}`);
  return ((await response.json()) as { fields?: Record<string, any> }).fields ?? {};
}

async function writeAnswer(
  uid: string,
  token: string,
  sdp: string,
  namedOffer: number,
  timeoutMs: number,
): Promise<void> {
  // The named offer is what the machine matches on, and the deployed rules
  // refuse an answer without it: an unattributable answer would have to be
  // placed by comparing the two peers' clocks.
  const mask = ["p2pAnswer", "p2pAnswerTs", "p2pAnswerOfferTs"]
    .map((f) => `updateMask.fieldPaths=${f}`).join("&");
  const response = await fetchBounded(`${docUrl(uid)}?${mask}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      fields: {
        p2pAnswer: { stringValue: sdp },
        p2pAnswerTs: { integerValue: String(Date.now()) },
        p2pAnswerOfferTs: { integerValue: String(namedOffer) },
      },
    }),
  }, timeoutMs);
  if (!response.ok) {
    throw new VerificationError(
      `publishing the answer was refused: HTTP ${response.status} ${await response.text()}`,
    );
  }
}

function candidateReport(sdp: string): { total: number; srflx: number } {
  const lines = sdp.split("\n").filter((line) => line.startsWith("a=candidate"));
  return {
    total: lines.length,
    srflx: lines.filter((line) => line.includes("typ srflx")).length,
  };
}

/** A verifier that can hang is a verifier that lies by silence: every stage is
 * bounded, including this one. */
async function gather(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  await Promise.race([
    new Promise<void>((resolve) => {
      const stop = pc.iceGatheringStateChange.subscribe((state) => {
        if (state === "complete") {
          stop();
          resolve();
        }
      });
    }),
    timeout(timeoutMs, "ICE gathering (the answer carries no candidates until it finishes)"),
  ]);
}

function timeout(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new VerificationError(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
}

/** `fetch` with a deadline: a hung HTTP call must not become a hung check. */
async function fetchBounded(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return await Promise.race([
    fetch(url, init),
    timeout(timeoutMs, `${init.method ?? "GET"} ${new URL(url).host}`),
  ]);
}

async function main(): Promise<void> {
  const timeoutMs = argValue("--timeout-ms", 60_000);
  // One watchdog for the whole run, so no stage can leave the check hanging.
  const watchdog = setTimeout(() => {
    console.error(`status: FAILED — the verification exceeded ${timeoutMs * 4}ms in total`);
    process.exit(1);
  }, timeoutMs * 4);
  watchdog.unref?.();

  const { idToken, uid } = await ownerIdToken(ownerRefreshToken(), timeoutMs);
  const fields = await readDoc(uid, idToken, timeoutMs);

  const offer = fields.p2pOffer?.stringValue;
  const offerTs = Number(fields.p2pOfferTs?.integerValue ?? NaN);
  if (typeof offer !== "string" || !Number.isFinite(offerTs)) {
    throw new VerificationError(
      "the discovery document carries no direct offer: peer-to-peer is off there (config `p2p`) "
      + "or the machine is not running the direct transport",
    );
  }
  const age = Date.now() - offerTs;
  const hostCandidates = candidateReport(offer);
  console.log(
    `offer: ${offer.length} bytes, ${hostCandidates.total} candidate(s), `
    + `${hostCandidates.srflx} srflx, published ${Math.round(age / 1000)}s ago`,
  );
  if (age > 60_000) {
    console.log(
      "NOTE: that offer is over a minute old, so its carrier-grade NAT mapping has probably "
      + "expired. The host refreshes a stale offer on its own; this run answers what is published.",
    );
  }

  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  let channelResolve: (channel: any) => void = () => {};
  const channelPromise = new Promise<any>((resolve) => { channelResolve = resolve; });
  pc.ondatachannel = (event) => channelResolve(event.channel);

  await pc.setRemoteDescription(new RTCSessionDescription(offer, "offer"));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await gather(pc, timeoutMs);
  await writeAnswer(uid, idToken, pc.localDescription!.sdp!, offerTs, timeoutMs);
  console.log(`answer: published, naming the offer (${offerTs}) it describes`);

  const channel = await Promise.race([channelPromise, timeout(timeoutMs, "the DataChannel")]);
  if (channel.readyState !== "open") {
    await Promise.race([
      new Promise<void>((resolve) => {
        channel.onopen = () => resolve();
        channel.stateChange.subscribe((state: string) => { if (state === "open") resolve(); });
      }),
      timeout(timeoutMs, "the DataChannel opening"),
    ]);
  }
  console.log(`channel: open (iceConnectionState=${pc.iceConnectionState})`);

  // Speak the REAL protocol over it: authenticate, then subscribe. Anything
  // less would only prove that bytes can move, not that this is a transport the
  // app could actually use.
  const frames: any[] = [];
  const stateFrame = new Promise<any>((resolve, reject) => {
    channel.onMessage.subscribe((data: unknown) => {
      let parsed: any;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      frames.push(parsed);
      if (parsed.type === "state") resolve(parsed);
      if (parsed.type === "error") reject(new VerificationError(`host refused: ${parsed.message}`));
    });
  });
  channel.send(JSON.stringify({ type: "auth", token: idToken }));
  channel.send(JSON.stringify({ type: "subscribe", sessionIds: [] }));

  const state = await Promise.race([stateFrame, timeout(timeoutMs, "a state frame")]);
  const sessions = Array.isArray(state.sessions) ? state.sessions.length : 0;
  console.log(`protocol: authenticated and received state with ${sessions} session(s)`);
  console.log(
    `status: OK — a second peer reached this machine over the direct channel `
    + `(${hostCandidates.srflx} srflx candidate(s) on offer, ICE ${pc.iceConnectionState})`,
  );
  console.log(
    "unproven here: traversal from a third network. Both peers ran on this machine, so a local "
    + "candidate could have carried the channel; a phone on another network is the remaining check.",
  );

  channel.close();
  pc.close();
  clearTimeout(watchdog);
}

try {
  await main();
} catch (error) {
  console.error(`status: FAILED — ${(error as Error).message}`);
  process.exitCode = 1;
}
