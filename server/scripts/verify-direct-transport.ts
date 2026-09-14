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
import { RTCPeerConnection, RTCSessionDescription } from "werift";
import {
  docUrl,
  fetchBounded,
  ownerIdToken,
  ownerRefreshToken,
  timeout,
  VerificationError,
} from "./firestore-rest.ts";
import {
  ACTIONS_CHANNEL_LABEL,
  PUSH_CHANNEL_LABEL,
} from "../src/p2p.ts";
import { FrameReader, FrameWriter } from "../src/p2p-framing.ts";



function argValue(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new VerificationError(`${name} needs a positive number of milliseconds`);
  }
  return value;
}



/** The signaling fields this check needs, with the offer's identity intact. */
interface Signaling {
  offer: string;
  offerTs: number;
  /** The offer the app has already answered, when it has. */
  answerOfferTs: number | null;
}


/** Read the live offer, and whether that exchange is already taken. */
async function readSignaling(uid: string, token: string, timeoutMs: number): Promise<Signaling> {
  const response = await fetchBounded(
    docUrl(uid),
    { headers: { Authorization: `Bearer ${token}` } },
    timeoutMs,
  );
  if (!response.ok) throw new VerificationError(`discovery read failed: HTTP ${response.status}`);
  const fields = ((await response.json()) as { fields?: Record<string, any> }).fields ?? {};
  const offer = fields.p2pOffer?.stringValue;
  const offerTs = Number(fields.p2pOfferTs?.integerValue ?? NaN);
  if (typeof offer !== "string" || !Number.isFinite(offerTs)) {
    throw new VerificationError(
      "the discovery document carries no direct offer: peer-to-peer is off there (config `p2p`) "
      + "or the machine is not running the direct transport",
    );
  }
  const answerOfferTs = Number(fields.p2pAnswerOfferTs?.integerValue ?? NaN);
  return { offer, offerTs, answerOfferTs: Number.isFinite(answerOfferTs) ? answerOfferTs : null };
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

/** Wait. The timer is deliberately NOT unref'd: an unref'd timer with no other
 * pending work lets Node exit mid-await (measured: exit 13, "unsettled
 * top-level await"), which would report a check that never happened. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}


/** Which candidate pairs actually succeeded, by type.
 *
 * "ICE connected" is not the same as "this traversal works from another
 * network": two peers on one machine can connect over a host candidate that no
 * phone could ever use. Naming the pair types is what separates the two, so the
 * on-machine result is quantified instead of assumed. */
async function describeCandidatePairs(pc: RTCPeerConnection): Promise<string> {
  let entries: any[];
  try {
    const report: any = await pc.getStats();
    entries = typeof report?.values === "function" ? [...report.values()] : Object.values(report ?? {});
  } catch (error) {
    return `the stats report could not be read (${(error as Error).message})`;
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const typeOf = (id: string): string => String(byId.get(id)?.candidateType ?? "unknown");
  const pairs = entries
    .filter((entry) => entry.type === "candidate-pair" && entry.state === "succeeded")
    .map((pair) => `${typeOf(pair.localCandidateId)}\u2194${typeOf(pair.remoteCandidateId)}`);
  if (pairs.length === 0) {
    return "no candidate pair was reported as succeeded";
  }
  const kinds = entries
    .filter((entry) => entry.type === "local-candidate" || entry.type === "remote-candidate")
    .map((entry) => String(entry.candidateType));
  return `${pairs.join(", ")} (gathered: ${[...new Set(kinds)].sort().join(", ")})`;
}

async function main(): Promise<void> {
  const timeoutMs = argValue("--timeout-ms", 60_000);
  // One watchdog for the whole run, so no stage can leave the check hanging.
  const watchdog = setTimeout(() => {
    console.error(`status: FAILED — the verification exceeded ${timeoutMs * 4}ms in total`);
    process.exit(1);
  }, timeoutMs * 4);

  const { idToken, uid } = await ownerIdToken(ownerRefreshToken(), timeoutMs);
  const first = await readSignaling(uid, idToken, timeoutMs);

  const age = Date.now() - first.offerTs;
  const hostCandidates = candidateReport(first.offer);
  console.log(
    `offer: ${first.offer.length} bytes, ${hostCandidates.total} candidate(s), `
    + `${hostCandidates.srflx} srflx, published ${Math.round(age / 1000)}s ago`,
  );
  if (age > 60_000) {
    console.log(
      "NOTE: that offer is over a minute old, so its carrier-grade NAT mapping has probably "
      + "expired. The machine refreshes a stale offer on its own; this run answers what it finds.",
    );
  }

  // The machine withdraws and republishes a stale offer on its own clock (45 s
  // while nothing is connected), so an answer written against the offer read a
  // moment ago can describe an exchange that no longer exists - exactly how the
  // app's own retry works, and why this has to read and answer again rather
  // than answer once and wait. An exchange the app has already answered is left
  // alone: one exchange takes one answer, and racing the app for it would prove
  // nothing about either peer.
  const deadline = Date.now() + timeoutMs * 4;
  let connected: { push: any; actions: any; pc: RTCPeerConnection } | null = null;
  let sawLabels: string[] = [];
  let answered = 0;
  while (Date.now() < deadline && connected === null) {
    // Poll tightly for an offer nobody has answered yet. The machine replaces a
    // stale offer every ~45s and the app answers within a few seconds, so an
    // exchange is only free briefly; a slow poll would never see one and would
    // report a failure of the transport that is really a race with the app.
    const signaling = await readSignaling(uid, idToken, timeoutMs);
    if (signaling.answerOfferTs === signaling.offerTs) {
      if (Date.now() + 1_500 < deadline) {
        await sleep(1_000);
        continue;
      }
      console.log(
        `offer ${signaling.offerTs}: already answered, and no newer offer appeared `
        + "- the app holds the exchange",
      );
      continue;
    }

    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    const opened = new Map<string, any>();
    let channelsResolve: () => void = () => {};
    const bothOpen = new Promise<void>((resolve) => { channelsResolve = resolve; });
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      const settle = (): void => {
        opened.set(channel.label, channel);
        if (opened.has(PUSH_CHANNEL_LABEL) && opened.has(ACTIONS_CHANNEL_LABEL)) {
          channelsResolve();
        }
      };
      if (channel.readyState === "open") {
        settle();
        return;
      }
      channel.stateChange.subscribe((state: string) => {
        if (state === "open") settle();
      });
    };

    await pc.setRemoteDescription(new RTCSessionDescription(signaling.offer, "offer"));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await gather(pc, timeoutMs);
    await writeAnswer(uid, idToken, pc.localDescription!.sdp!, signaling.offerTs, timeoutMs);
    answered += 1;
    console.log(
      `answer ${answered}: published, naming the offer (${signaling.offerTs}) it describes, `
      + `${Math.round((Date.now() - signaling.offerTs) / 1000)}s after that offer was published`,
    );

    // One offer's punch has this long to land before the exchange is presumed
    // replaced; the outer loop then reads the document again.
    const won = await Promise.race([
      bothOpen.then(() => true),
      sleep(Math.min(12_000, Math.max(1_000, deadline - Date.now()))).then(() => false),
    ]);
    sawLabels = [...opened.keys()];
    if (won) {
      connected = {
        push: opened.get(PUSH_CHANNEL_LABEL)!,
        actions: opened.get(ACTIONS_CHANNEL_LABEL)!,
        pc,
      };
      console.log(
        `channels: both open (${PUSH_CHANNEL_LABEL}, ${ACTIONS_CHANNEL_LABEL}; `
        + `iceConnectionState=${pc.iceConnectionState})`,
      );
      console.log(`pairs: ${await describeCandidatePairs(pc)}`);
    } else {
      console.log(
        `punch ${answered}: no channels after 12s (saw ${sawLabels.length === 0 ? "none" : sawLabels.join(", ")}); `
        + "reading the document for a newer offer",
      );
      pc.close();
    }
  }

  if (connected === null) {
    throw new VerificationError(
      `${answered} answer(s) were published but no pair of channels ever opened `
      + `(last attempt saw ${sawLabels.length === 0 ? "none" : sawLabels.join(", ")}, expected `
      + `${PUSH_CHANNEL_LABEL} and ${ACTIONS_CHANNEL_LABEL})`,
    );
  }
  const { push, actions, pc } = connected;

  // Speak the REAL protocol over the framed channels: authenticate, then
  // subscribe. Anything less would only prove that bytes can move, not that
  // this is a transport the app could actually use.
  const reader = new FrameReader();
  const writer = new FrameWriter();
  let largest = 0;
  let framesIn = 0;
  /** Every frame type that arrived, so a timeout can say what DID come back
   * instead of only what did not. */
  const frameTypes: string[] = [];
  const stateFrame = new Promise<any>((resolve, reject) => {
    push.onMessage.subscribe((data: unknown) => {
      let payload: string | null;
      try {
        payload = reader.accept(Buffer.from(data as ArrayBuffer | Buffer));
      } catch (error) {
        reject(new VerificationError(`a push arrived that is not a frame: ${(error as Error).message}`));
        return;
      }
      if (payload === null) {
        return;
      }
      framesIn += 1;
      largest = Math.max(largest, payload.length);
      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        frameTypes.push("(unparseable)");
        return;
      }
      if (frameTypes.length < 12) frameTypes.push(String(parsed.type));
      if (parsed.type === "state") resolve(parsed);
      if (parsed.type === "error") reject(new VerificationError(`the machine refused: ${parsed.message}`));
    });
  });
  // The same frames the app sends, split the same way.
  const send = (message: unknown): void => {
    for (const frame of writer.frames(JSON.stringify(message))) {
      actions.send(frame);
    }
  };
  send({ type: "auth", token: idToken });
  send({ type: "subscribe", sessionIds: [] });
  // What THIS peer did with the bytes: a DataChannel that never handed them to
  // SCTP and one whose bytes died on the wire look identical from the far end.
  const sent = actions as unknown as { messagesSent?: number; bytesSent?: number; bufferedAmount?: number };
  console.log(
    `sent: ${sent.messagesSent ?? "?"} message(s), ${sent.bytesSent ?? "?"} bytes, `
    + `${sent.bufferedAmount ?? "?"} still buffered (channel ${actions.readyState})`,
  );

  const state = await Promise.race([
    stateFrame,
    timeout(timeoutMs, "a state frame over the direct channel"),
  ]).catch((error: Error) => {
    // The negative must be printable: an empty channel and a channel that
    // answered with something else are different failures.
    throw new VerificationError(
      `${error.message}; the peer sent nothing back (${
        frameTypes.length === 0 ? "no frames at all" : `saw ${frameTypes.join(", ")}`
      })`,
    );
  });
  const sessions = Array.isArray(state.sessions) ? state.sessions.length : 0;
  console.log(
    `protocol: authenticated over the direct channel and received state with ${sessions} session(s) `
    + `(${framesIn} frame(s) reassembled, largest ${largest} bytes)`,
  );
  const reported = state.p2p as { channelOpen?: boolean; exchanges?: number } | undefined;
  if (reported) {
    console.log(
      `machine status: channelOpen=${reported.channelOpen} exchanges=${reported.exchanges}`,
    );
  }
  console.log(
    `status: OK — a second peer reached this machine over the direct channel `
    + `(ice=${pc.iceConnectionState}, framed two-channel protocol, ${framesIn} frame(s) in)`,
  );
  console.log(
    "unproven here: traversal from a third network. Both peers ran on this machine, so a local "
    + "candidate could have carried the channel; a phone on another network is the remaining check.",
  );

  push.close();
  actions.close();
  pc.close();
  clearTimeout(watchdog);
}

try {
  await main();
} catch (error) {
  console.error(`status: FAILED — ${(error as Error).message}`);
  process.exitCode = 1;
}
