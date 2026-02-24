import { describe, expect, it } from "vitest";
import {
  PREAMBLE_BITS_V2,
  SYNC_BITS_V2,
  buildFrameBitsV2,
  parseLenFlagU16,
} from "./protocol";

describe("protocol v2", () => {
  it("builds a valid v2 frame", () => {
    const frame = buildFrameBitsV2("hello");

    expect(frame.bits.startsWith(`${PREAMBLE_BITS_V2}${SYNC_BITS_V2}`)).toBe(true);
    expect(frame.payloadBits.length).toBe(frame.txBytes * 8);
    expect(frame.rawBytes).toBe(5);
  });

  it("sets compression flag when payload is compressed", () => {
    const frame = buildFrameBitsV2("a".repeat(400));

    const lenBitsStart = PREAMBLE_BITS_V2.length + SYNC_BITS_V2.length;
    const lenBits = frame.bits.slice(lenBitsStart, lenBitsStart + 16);
    const parsed = parseLenFlagU16(lenBits);

    expect(parsed.compressed).toBe(true);
    expect(parsed.lenBytes).toBe(frame.txBytes);
    expect(frame.compressed).toBe(true);
  });

  it("keeps raw payload when compression gain is not enough", () => {
    const frame = buildFrameBitsV2("abc");

    const lenBitsStart = PREAMBLE_BITS_V2.length + SYNC_BITS_V2.length;
    const lenBits = frame.bits.slice(lenBitsStart, lenBitsStart + 16);
    const parsed = parseLenFlagU16(lenBits);

    expect(frame.compressed).toBe(false);
    expect(parsed.compressed).toBe(false);
    expect(parsed.lenBytes).toBe(frame.txBytes);
  });
});
