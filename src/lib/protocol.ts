import { deflateRaw } from "pako";

export const PREAMBLE_BITS_V2 = "01".repeat(16); // 32 bits
export const SYNC_BITS_V2 = "11110000".repeat(2); // 16 bits
const LEN_FLAG_MASK = 0x8000;
const LEN_VALUE_MASK = 0x7fff;
const COMPRESS_MIN_RAW_BYTES = 24;
const COMPRESS_MIN_GAIN_BYTES = 2;

export type EncodedFrame = {
  bits: string;
  compressed: boolean;
  rawBytes: number;
  txBytes: number;
};

function bytesToBitStream(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(2).padStart(8, "0")).join("");
}

function u16ToBits(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
    throw new Error(`u16 out of range: ${n}`);
  }
  return n.toString(2).padStart(16, "0");
}

export function parseLenFlagU16(bits16: string): {
  compressed: boolean;
  lenBytes: number;
} {
  const value = parseInt(bits16, 2);
  if (!Number.isFinite(value) || value < 0 || value > 0xffff) {
    throw new Error("invalid len flag bits");
  }
  return {
    compressed: (value & LEN_FLAG_MASK) !== 0,
    lenBytes: value & LEN_VALUE_MASK,
  };
}

export function buildFrameBitsV2(text: string): EncodedFrame {
  const raw = new TextEncoder().encode(text);
  if (raw.length > LEN_VALUE_MASK) {
    throw new Error(`payload too large: ${raw.length} bytes (max ${LEN_VALUE_MASK})`);
  }

  const compressedCandidate = deflateRaw(raw);
  const shouldCompress =
    raw.length >= COMPRESS_MIN_RAW_BYTES &&
    compressedCandidate.length + COMPRESS_MIN_GAIN_BYTES < raw.length;

  const payload = shouldCompress ? compressedCandidate : raw;
  if (payload.length > LEN_VALUE_MASK) {
    throw new Error(
      `encoded payload too large: ${payload.length} bytes (max ${LEN_VALUE_MASK})`,
    );
  }

  const lenFlag = (shouldCompress ? LEN_FLAG_MASK : 0) | payload.length;
  const lenBits = u16ToBits(lenFlag);
  const payloadBits = bytesToBitStream(payload);
  const bits = `${PREAMBLE_BITS_V2}${SYNC_BITS_V2}${lenBits}${payloadBits}`;

  return {
    bits,
    compressed: shouldCompress,
    rawBytes: raw.length,
    txBytes: payload.length,
  };
}
