import { describe, expect, it } from "vitest";
import {
  PREAMBLE_BITS_V2,
  SYNC_BITS_V3,
  buildFrameBitsV2,
  buildFrameBitsV3,
  parseHeaderV3,
  verifyCrc16,
} from "./protocol";

describe("protocol v3", () => {
  it("builds and verifies a v3 frame", () => {
    const frame = buildFrameBitsV3("hello v3", 7);

    const headerStart = PREAMBLE_BITS_V2.length + SYNC_BITS_V3.length;
    const headerBits = frame.bits.slice(headerStart, headerStart + 32);
    const payloadStart = headerStart + 32;
    const payloadEnd = payloadStart + frame.txBytes * 8;
    const payloadBits = frame.bits.slice(payloadStart, payloadEnd);
    const crcBits = frame.bits.slice(payloadEnd, payloadEnd + 16);

    const header = parseHeaderV3(headerBits);

    expect(frame.version).toBe("v3");
    expect(header.seq).toBe(7);
    expect(header.lenBytes).toBe(frame.txBytes);
    expect(header.compressed).toBe(frame.compressed);
    expect(verifyCrc16(headerBits, payloadBits, crcBits)).toBe(true);
  });

  it("detects crc mismatch after tampering", () => {
    const frame = buildFrameBitsV3("crc guard", 33);

    const headerStart = PREAMBLE_BITS_V2.length + SYNC_BITS_V3.length;
    const headerBits = frame.bits.slice(headerStart, headerStart + 32);
    const payloadStart = headerStart + 32;
    const payloadEnd = payloadStart + frame.txBytes * 8;
    const payloadBits = frame.bits.slice(payloadStart, payloadEnd);
    const crcBits = frame.bits.slice(payloadEnd, payloadEnd + 16);

    const flippedPayloadBits = `${payloadBits[0] === "1" ? "0" : "1"}${payloadBits.slice(1)}`;
    expect(verifyCrc16(headerBits, flippedPayloadBits, crcBits)).toBe(false);
  });

  it("marks compression flag when payload is effectively compressed", () => {
    const text = "a".repeat(400);
    const frame = buildFrameBitsV3(text, 1);
    const headerStart = PREAMBLE_BITS_V2.length + SYNC_BITS_V3.length;
    const headerBits = frame.bits.slice(headerStart, headerStart + 32);
    const header = parseHeaderV3(headerBits);

    expect(frame.rawBytes).toBeGreaterThanOrEqual(24);
    expect(frame.compressed).toBe(true);
    expect(header.compressed).toBe(true);
  });
});

describe("protocol v2", () => {
  it("still builds legacy v2 frame", () => {
    const frame = buildFrameBitsV2("legacy");
    expect(frame.version).toBe("v2");
    expect(frame.bits.startsWith(PREAMBLE_BITS_V2)).toBe(true);
  });
});
