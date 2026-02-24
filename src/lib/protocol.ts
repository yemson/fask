import { deflateRaw } from "pako";

export type ProtocolVersion = "v2" | "v3";

export const PREAMBLE_BITS_V2 = "01".repeat(16); // 32 bits
export const SYNC_BITS_V2 = "11110000".repeat(2); // 16 bits
export const SYNC_BITS_V3 = "11001100".repeat(2); // 16 bits

const LEN_FLAG_MASK = 0x8000;
const LEN_VALUE_MASK = 0x7fff;
const COMPRESS_MIN_RAW_BYTES = 24;
const COMPRESS_MIN_GAIN_BYTES = 2;

const V3_VERSION_BITS = "10";
const V3_RESERVED_FLAGS_MASK = 0b111110;

export type EncodedFrameBase = {
  bits: string;
  payloadBits: string;
  compressed: boolean;
  rawBytes: number;
  txBytes: number;
};

export type EncodedFrameV2 = EncodedFrameBase & {
  version: "v2";
};

export type EncodedFrameV3 = EncodedFrameBase & {
  version: "v3";
  seq: number;
  crc16: number;
};

export type EncodedFrame = EncodedFrameV2 | EncodedFrameV3;

export type V3Header = {
  version: "v3";
  flags: number;
  compressed: boolean;
  seq: number;
  lenBytes: number;
};

export function bytesToBitStream(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(2).padStart(8, "0")).join("");
}

export function bitStreamToBytes(bits: string): Uint8Array {
  if (bits.length % 8 !== 0) {
    throw new Error("bits length not multiple of 8");
  }

  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return out;
}

function u8ToBits(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 0xff) {
    throw new Error(`u8 out of range: ${n}`);
  }
  return n.toString(2).padStart(8, "0");
}

function u16ToBits(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
    throw new Error(`u16 out of range: ${n}`);
  }
  return n.toString(2).padStart(16, "0");
}

function pickPayload(raw: Uint8Array) {
  const compressedCandidate = deflateRaw(raw);
  const shouldCompress =
    raw.length >= COMPRESS_MIN_RAW_BYTES &&
    compressedCandidate.length + COMPRESS_MIN_GAIN_BYTES < raw.length;

  return {
    payload: shouldCompress ? compressedCandidate : raw,
    compressed: shouldCompress,
  };
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

export function buildHeaderV3Bits(input: {
  compressed: boolean;
  seq: number;
  lenBytes: number;
}): string {
  const flags = input.compressed ? 1 : 0;
  const seqBits = u8ToBits(input.seq);
  const lenBits = u16ToBits(input.lenBytes);
  return `${V3_VERSION_BITS}${flags.toString(2).padStart(6, "0")}${seqBits}${lenBits}`;
}

export function parseHeaderV3(bits32: string): V3Header {
  if (bits32.length !== 32) {
    throw new Error(`invalid V3 header length: ${bits32.length}`);
  }

  const versionBits = bits32.slice(0, 2);
  if (versionBits !== V3_VERSION_BITS) {
    throw new Error("invalid V3 version bits");
  }

  const flags = parseInt(bits32.slice(2, 8), 2);
  if ((flags & V3_RESERVED_FLAGS_MASK) !== 0) {
    throw new Error("invalid V3 reserved flag bits");
  }

  const seq = parseInt(bits32.slice(8, 16), 2);
  const lenBytes = parseInt(bits32.slice(16, 32), 2);
  if (lenBytes > LEN_VALUE_MASK) {
    throw new Error("invalid V3 length");
  }

  return {
    version: "v3",
    flags,
    compressed: (flags & 0b1) !== 0,
    seq,
    lenBytes,
  };
}

export function crc16CcittFalse(data: Uint8Array): number {
  let crc = 0xffff;

  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let b = 0; b < 8; b++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }

  return crc;
}

export function calculateV3Crc16Bits(headerBits: string, payloadBits: string): string {
  const crc = crc16CcittFalse(bitStreamToBytes(`${headerBits}${payloadBits}`));
  return u16ToBits(crc);
}

export function verifyCrc16(headerBits: string, payloadBits: string, crcBits: string): boolean {
  if (crcBits.length !== 16) return false;
  return calculateV3Crc16Bits(headerBits, payloadBits) === crcBits;
}

export function buildFrameBitsV2(text: string): EncodedFrameV2 {
  const raw = new TextEncoder().encode(text);
  if (raw.length > LEN_VALUE_MASK) {
    throw new Error(`payload too large: ${raw.length} bytes (max ${LEN_VALUE_MASK})`);
  }

  const { payload, compressed } = pickPayload(raw);
  if (payload.length > LEN_VALUE_MASK) {
    throw new Error(
      `encoded payload too large: ${payload.length} bytes (max ${LEN_VALUE_MASK})`,
    );
  }

  const lenFlag = (compressed ? LEN_FLAG_MASK : 0) | payload.length;
  const lenBits = u16ToBits(lenFlag);
  const payloadBits = bytesToBitStream(payload);
  const bits = `${PREAMBLE_BITS_V2}${SYNC_BITS_V2}${lenBits}${payloadBits}`;

  return {
    version: "v2",
    bits,
    payloadBits,
    compressed,
    rawBytes: raw.length,
    txBytes: payload.length,
  };
}

export function buildFrameBitsV3(
  text: string,
  seq: number,
): EncodedFrameV3 {
  const raw = new TextEncoder().encode(text);
  if (raw.length > LEN_VALUE_MASK) {
    throw new Error(`payload too large: ${raw.length} bytes (max ${LEN_VALUE_MASK})`);
  }

  const { payload, compressed } = pickPayload(raw);
  if (payload.length > LEN_VALUE_MASK) {
    throw new Error(
      `encoded payload too large: ${payload.length} bytes (max ${LEN_VALUE_MASK})`,
    );
  }

  const safeSeq = ((seq % 256) + 256) % 256;
  const payloadBits = bytesToBitStream(payload);
  const headerBits = buildHeaderV3Bits({
    compressed,
    seq: safeSeq,
    lenBytes: payload.length,
  });
  const crcBits = calculateV3Crc16Bits(headerBits, payloadBits);
  const crc16 = parseInt(crcBits, 2);

  const bits = `${PREAMBLE_BITS_V2}${SYNC_BITS_V3}${headerBits}${payloadBits}${crcBits}`;

  return {
    version: "v3",
    bits,
    payloadBits,
    compressed,
    rawBytes: raw.length,
    txBytes: payload.length,
    seq: safeSeq,
    crc16,
  };
}
