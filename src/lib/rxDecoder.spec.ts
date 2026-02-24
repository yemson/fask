import { describe, expect, it } from "vitest";
import { buildFrameBitsV2, buildFrameBitsV3 } from "./protocol";
import { RxBitDecoder } from "./rxDecoder";

function feedBits(decoder: RxBitDecoder, bits: string) {
  const events: ReturnType<RxBitDecoder["consumeBit"]>[] = [];
  for (let i = 0; i < bits.length; i++) {
    const event = decoder.consumeBit(bits[i]);
    if (event) events.push(event);
  }
  return events;
}

describe("RxBitDecoder", () => {
  it("decodes a valid v3 frame", () => {
    const decoder = new RxBitDecoder({ allowV2Fallback: false });
    const frame = buildFrameBitsV3("decoder-v3", 19);

    const events = feedBits(decoder, frame.bits);
    const done = events.find((e) => e?.kind === "frame");

    expect(done).toBeTruthy();
    if (done && done.kind === "frame") {
      expect(done.frame.version).toBe("v3");
      expect(done.frame.seq).toBe(19);
      expect(done.frame.text).toBe("decoder-v3");
    }
    expect(decoder.getStats().okFrames).toBe(1);
  });

  it("resyncs with crc_fail on corrupted v3 payload", () => {
    const decoder = new RxBitDecoder({ allowV2Fallback: false });
    const frame = buildFrameBitsV3("crc-error", 4);

    const bits = frame.bits.split("");
    const payloadBitIndex = 32 + 16 + 32 + 3;
    bits[payloadBitIndex] = bits[payloadBitIndex] === "1" ? "0" : "1";

    const events = feedBits(decoder, bits.join(""));
    const err = events.find((e) => e?.kind === "error" && e.code === "crc_fail");

    expect(err).toBeTruthy();
    expect(decoder.getStats().crcFail).toBe(1);
    expect(decoder.getStats().resyncCount).toBe(1);
  });

  it("decodes v2 only when fallback is enabled", () => {
    const v2Frame = buildFrameBitsV2("legacy-path");

    const decoderStrict = new RxBitDecoder({ allowV2Fallback: false });
    const strictEvents = feedBits(decoderStrict, v2Frame.bits);
    const strictDone = strictEvents.find((e) => e?.kind === "frame");
    expect(strictDone).toBeUndefined();

    const decoderFallback = new RxBitDecoder({ allowV2Fallback: true });
    const fallbackEvents = feedBits(decoderFallback, v2Frame.bits);
    const fallbackDone = fallbackEvents.find((e) => e?.kind === "frame");
    expect(fallbackDone).toBeTruthy();

    if (fallbackDone && fallbackDone.kind === "frame") {
      expect(fallbackDone.frame.version).toBe("v2");
      expect(fallbackDone.frame.text).toBe("legacy-path");
    }
  });
});
