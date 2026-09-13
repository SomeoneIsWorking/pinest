/** The image cap: what may enter a session's context.
 *
 * The failure this exists for: a 4K screenshot entered a session as a 3.0 MiB
 * base64 part, the provider answered 413 to every request afterwards, and that
 * session could not run again. The cap must therefore be enforced in bytes, and
 * an image that cannot be scaled must be dropped with a reason rather than sent.
 */
import "../support/isolate-config.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { base64Bytes, boundImageContent, shrinkImage } from "../src/image-budget.ts";

/** A real, large PNG built with the same codec the cap uses. */
async function bigImageBase64(width = 2400, height = 1600): Promise<string> {
  const photon: any = await import("@silvia-odwyer/photon-node");
  const pixels = new Uint8Array(width * height * 4);
  // Noise so the PNG cannot compress away the size we are testing.
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 2654435761) % 251;
  const image = new photon.PhotonImage(pixels, width, height);
  try {
    return Buffer.from(image.get_bytes()).toString("base64");
  } finally {
    image.free();
  }
}

test("an image inside the budget is passed through byte-identical", async () => {
  const data = await bigImageBase64(64, 64);
  const content = [{ type: "image", data, mimeType: "image/png" }];

  const bounded = await boundImageContent(content, 4 * 1024 * 1024);

  assert.equal(bounded.changed, false, "nothing to do: re-encoding would cost quality for no reason");
  assert.deepEqual(bounded.content, content);
  assert.deepEqual(bounded.notes, []);
});

test("an oversized image comes out under the cap, as jpeg, with a note", async () => {
  const data = await bigImageBase64();
  const original = base64Bytes(data);
  const cap = 512 * 1024;
  assert.ok(original > cap, `fixture must exceed the cap (was ${original} bytes)`);

  const bounded = await boundImageContent([{ type: "image", data, mimeType: "image/png" }], cap);

  assert.equal(bounded.changed, true);
  const image = bounded.content.find((part: any) => part.type === "image") as any;
  assert.equal(image.mimeType, "image/jpeg");
  assert.ok(
    base64Bytes(image.data) <= cap,
    `scaled image is ${base64Bytes(image.data)} bytes, cap is ${cap}`,
  );
  assert.ok(base64Bytes(image.data) < original, "it must actually be smaller");
  assert.match(bounded.notes.join(" "), /image scaled from/);
});

test("an image that cannot be scaled is omitted with the reason, never sent", async () => {
  const data = Buffer.from("this is not an image at all, just bytes").toString("base64");
  const cap = 8; // smaller than the payload above

  const bounded = await boundImageContent([{ type: "image", data, mimeType: "image/png" }], cap);

  assert.equal(bounded.changed, true);
  assert.equal(bounded.content.some((part: any) => part.type === "image"), false);
  const note = (bounded.content.find((part: any) => part.type === "text") as any).text as string;
  assert.match(note, /image omitted/);
  assert.match(note, /capture a smaller region/);
});

test("tool results without images are not touched at all", async () => {
  const content = [{ type: "text", text: "plain output" }];
  const bounded = await boundImageContent(content, 1024);
  assert.equal(bounded.changed, false);
  assert.deepEqual(bounded.content, content);
});

test("base64 sizes are computed without decoding", () => {
  assert.equal(base64Bytes(""), 0);
  assert.equal(base64Bytes("QQ=="), 1);
  assert.equal(base64Bytes("QUI="), 2);
  assert.equal(base64Bytes("QUJD"), 3);
  assert.equal(base64Bytes("QUJDRA=="), 4);
});

test("shrinkImage refuses a sane cap it cannot reach instead of looping forever", async () => {
  const data = await bigImageBase64(200, 200);
  // 1 byte can never be satisfied: the callers must get null, not a hung process.
  const shrunk = await shrinkImage(data, "image/png", 1);
  assert.equal(shrunk, null);
});
