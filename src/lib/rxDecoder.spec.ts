import { describe, expect, it } from "vitest";
import { buildFrameBitsV2 } from "./protocol";
import { RxBitDecoder } from "./rxDecoder";

function feedBits(decoder: RxBitDecoder, bits: string) {
  const events: ReturnType<RxBitDecoder["consumeBit"]>[] = [];
  for (let i = 0; i < bits.length; i++) {
    const event = decoder.consumeBit(bits[i]);
    if (event) events.push(event);
  }
  return events;
}

describe("RxBitDecoder v2", () => {
  it("decodes a valid v2 frame", () => {
    const decoder = new RxBitDecoder();
    const frame = buildFrameBitsV2("decoder-v2");

    const events = feedBits(decoder, frame.bits);
    const done = events.find((e) => e?.kind === "frame");

    expect(done).toBeTruthy();
    if (done && done.kind === "frame") {
      expect(done.frame.text).toBe("decoder-v2");
      expect(done.frame.compressed).toBe(frame.compressed);
      expect(done.frame.lenBytes).toBe(frame.txBytes);
    }

    expect(decoder.getStats().okFrames).toBe(1);
  });

  it("resyncs with decode_fail on corrupted payload", () => {
    const decoder = new RxBitDecoder();
    const frame = buildFrameBitsV2("this should compress and fail".repeat(8));

    const bits = frame.bits.split("");
    const payloadBitIndex = 32 + 16 + 16 + 4;
    bits[payloadBitIndex] = bits[payloadBitIndex] === "1" ? "0" : "1";

    const events = feedBits(decoder, bits.join(""));
    const err = events.find((e) => e?.kind === "error" && e.code === "decode_fail");

    expect(err).toBeTruthy();
    expect(decoder.getStats().decodeFail).toBe(1);
    expect(decoder.getStats().resyncCount).toBe(1);
  });
});
