import { inflateRaw } from "pako";
import {
  PREAMBLE_BITS_V2,
  SYNC_BITS_V2,
  SYNC_BITS_V3,
  bitStreamToBytes,
  parseHeaderV3,
  parseLenFlagU16,
  verifyCrc16,
} from "./protocol";

const PREAMBLE_MATCH_MIN = 28;
const SYNC_MAX_ERRORS = 3;
const MAX_PAYLOAD_BYTES = 0x7fff;

const INVERTED_PREAMBLE_BITS = PREAMBLE_BITS_V2.split("")
  .map((b) => (b === "1" ? "0" : "1"))
  .join("");

type DecoderState =
  | { mode: "search_preamble"; window: string }
  | { mode: "search_sync"; window: string; invert: boolean }
  | { mode: "read_v3_header"; bits: string; invert: boolean }
  | {
      mode: "read_v3_payload";
      headerBits: string;
      lenBytes: number;
      compressed: boolean;
      seq: number;
      bits: string;
      invert: boolean;
    }
  | {
      mode: "read_v3_crc";
      headerBits: string;
      payloadBits: string;
      compressed: boolean;
      seq: number;
      bits: string;
      invert: boolean;
    }
  | { mode: "read_v2_len"; bits: string; invert: boolean }
  | {
      mode: "read_v2_payload";
      lenBytes: number;
      compressed: boolean;
      bits: string;
      invert: boolean;
    };

export type DecoderErrorCode =
  | "crc_fail"
  | "len_invalid"
  | "decode_fail"
  | "sync_lost";

export type DecoderStats = {
  okFrames: number;
  crcFail: number;
  lenInvalid: number;
  decodeFail: number;
  syncLost: number;
  resyncCount: number;
  lastError: DecoderErrorCode | null;
};

export type DecoderFrame = {
  text: string;
  version: "v2" | "v3";
  compressed: boolean;
  lenBytes: number;
  seq: number | null;
};

export type DecoderEvent =
  | { kind: "status"; message: string; lenBytes?: number }
  | { kind: "error"; code: DecoderErrorCode; message: string }
  | { kind: "frame"; frame: DecoderFrame; message: string };

function countMatches(a: string, b: string) {
  if (a.length !== b.length) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) matches += 1;
  }
  return matches;
}

function hammingDistance(a: string, b: string) {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let errors = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) errors += 1;
  }
  return errors;
}

function normalizeInflatedBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "string") return new TextEncoder().encode(data);
  throw new Error("unsupported inflate result type");
}

function decodePayload(bits: string, compressed: boolean): string {
  const payloadBytes = bitStreamToBytes(bits);
  const decodedBytes = compressed
    ? normalizeInflatedBytes(inflateRaw(payloadBytes))
    : payloadBytes;
  return new TextDecoder().decode(decodedBytes);
}

function flipBit(bit: string) {
  return bit === "1" ? "0" : "1";
}

export class RxBitDecoder {
  private state: DecoderState = { mode: "search_preamble", window: "" };

  private stats: DecoderStats = {
    okFrames: 0,
    crcFail: 0,
    lenInvalid: 0,
    decodeFail: 0,
    syncLost: 0,
    resyncCount: 0,
    lastError: null,
  };

  private readonly allowV2Fallback: boolean;

  constructor(input?: { allowV2Fallback?: boolean }) {
    this.allowV2Fallback = input?.allowV2Fallback ?? false;
  }

  reset() {
    this.state = { mode: "search_preamble", window: "" };
  }

  getStats(): DecoderStats {
    return { ...this.stats };
  }

  getMode(): DecoderState["mode"] {
    return this.state.mode;
  }

  private resync(errorCode: DecoderErrorCode, message: string): DecoderEvent {
    this.stats.lastError = errorCode;
    this.stats.resyncCount += 1;
    if (errorCode === "crc_fail") this.stats.crcFail += 1;
    if (errorCode === "len_invalid") this.stats.lenInvalid += 1;
    if (errorCode === "decode_fail") this.stats.decodeFail += 1;
    if (errorCode === "sync_lost") this.stats.syncLost += 1;

    this.state = { mode: "search_preamble", window: "" };
    return { kind: "error", code: errorCode, message };
  }

  consumeBit(rawBit: string): DecoderEvent | null {
    const pushWindow = (window: string, maxLen: number, nextBit: string) => {
      return (window + nextBit).slice(-maxLen);
    };

    if (this.state.mode === "search_preamble") {
      const w = pushWindow(this.state.window, PREAMBLE_BITS_V2.length, rawBit);
      this.state = { mode: "search_preamble", window: w };

      if (w.length === PREAMBLE_BITS_V2.length) {
        const normalMatches = countMatches(w, PREAMBLE_BITS_V2);
        const invertedMatches = countMatches(w, INVERTED_PREAMBLE_BITS);
        if (
          normalMatches >= PREAMBLE_MATCH_MIN ||
          invertedMatches >= PREAMBLE_MATCH_MIN
        ) {
          const invert = invertedMatches > normalMatches;
          const best = Math.max(normalMatches, invertedMatches);
          this.state = { mode: "search_sync", window: "", invert };
          return {
            kind: "status",
            message: `preamble ok (${best}/${PREAMBLE_BITS_V2.length}), find sync...`,
          };
        }
      }
      return null;
    }

    const bit = this.state.invert ? flipBit(rawBit) : rawBit;

    if (this.state.mode === "search_sync") {
      const w = pushWindow(this.state.window, SYNC_BITS_V3.length, bit);
      this.state = {
        mode: "search_sync",
        window: w,
        invert: this.state.invert,
      };

      if (w.length !== SYNC_BITS_V3.length) return null;

      const v3Errors = hammingDistance(w, SYNC_BITS_V3);
      const v2Errors = this.allowV2Fallback
        ? hammingDistance(w, SYNC_BITS_V2)
        : Number.POSITIVE_INFINITY;

      if (v3Errors <= SYNC_MAX_ERRORS && v3Errors <= v2Errors) {
        this.state = {
          mode: "read_v3_header",
          bits: "",
          invert: this.state.invert,
        };
        return { kind: "status", message: `sync v3 ok (err=${v3Errors}), read header...` };
      }

      if (v2Errors <= SYNC_MAX_ERRORS) {
        this.state = {
          mode: "read_v2_len",
          bits: "",
          invert: this.state.invert,
        };
        return { kind: "status", message: `sync v2 ok (err=${v2Errors}), read len...` };
      }

      return null;
    }

    if (this.state.mode === "read_v3_header") {
      const bits = this.state.bits + bit;
      if (bits.length < 32) {
        this.state = {
          mode: "read_v3_header",
          bits,
          invert: this.state.invert,
        };
        return null;
      }

      try {
        const parsed = parseHeaderV3(bits);
        if (parsed.lenBytes > MAX_PAYLOAD_BYTES) {
          return this.resync("len_invalid", `invalid V3 len=${parsed.lenBytes}, resync...`);
        }

        this.state = {
          mode: "read_v3_payload",
          headerBits: bits,
          lenBytes: parsed.lenBytes,
          compressed: parsed.compressed,
          seq: parsed.seq,
          bits: "",
          invert: this.state.invert,
        };

        return {
          kind: "status",
          message: `v3 len=${parsed.lenBytes} bytes (seq=${parsed.seq}, ${parsed.compressed ? "compressed" : "raw"}), read payload...`,
          lenBytes: parsed.lenBytes,
        };
      } catch {
        return this.resync("len_invalid", "invalid V3 header, resync...");
      }
    }

    if (this.state.mode === "read_v3_payload") {
      const needBits = this.state.lenBytes * 8;
      const bits = this.state.bits + bit;

      if (bits.length < needBits) {
        this.state = {
          ...this.state,
          bits,
        };
        return null;
      }

      this.state = {
        mode: "read_v3_crc",
        headerBits: this.state.headerBits,
        payloadBits: bits.slice(0, needBits),
        compressed: this.state.compressed,
        seq: this.state.seq,
        bits: "",
        invert: this.state.invert,
      };
      return { kind: "status", message: "payload done, read crc..." };
    }

    if (this.state.mode === "read_v3_crc") {
      const bits = this.state.bits + bit;
      if (bits.length < 16) {
        this.state = {
          ...this.state,
          bits,
        };
        return null;
      }

      const crcBits = bits.slice(0, 16);
      if (!verifyCrc16(this.state.headerBits, this.state.payloadBits, crcBits)) {
        return this.resync("crc_fail", "crc mismatch, resync...");
      }

      try {
        const finalized = this.state;
        const text = decodePayload(finalized.payloadBits, finalized.compressed);
        this.stats.okFrames += 1;
        this.state = { mode: "search_preamble", window: "" };
        return {
          kind: "frame",
          frame: {
            text,
            version: "v3",
            compressed: finalized.compressed,
            lenBytes: finalized.payloadBits.length / 8,
            seq: finalized.seq,
          },
          message: `DONE v3 (seq=${finalized.seq}). back to preamble search.`,
        };
      } catch {
        return this.resync("decode_fail", "decode error, resync...");
      }
    }

    if (this.state.mode === "read_v2_len") {
      const bits = this.state.bits + bit;
      if (bits.length < 16) {
        this.state = {
          mode: "read_v2_len",
          bits,
          invert: this.state.invert,
        };
        return null;
      }

      const { compressed, lenBytes } = parseLenFlagU16(bits);
      if (lenBytes > MAX_PAYLOAD_BYTES) {
        return this.resync("len_invalid", `invalid V2 len=${lenBytes}, resync...`);
      }

      this.state = {
        mode: "read_v2_payload",
        lenBytes,
        compressed,
        bits: "",
        invert: this.state.invert,
      };

      return {
        kind: "status",
        message: `v2 len=${lenBytes} bytes (${compressed ? "compressed" : "raw"}), read payload...`,
        lenBytes,
      };
    }

    if (this.state.mode === "read_v2_payload") {
      const needBits = this.state.lenBytes * 8;
      const bits = this.state.bits + bit;

      if (bits.length < needBits) {
        this.state = {
          ...this.state,
          bits,
        };
        return null;
      }

      try {
        const finalized = this.state;
        const text = decodePayload(bits.slice(0, needBits), finalized.compressed);
        this.stats.okFrames += 1;
        this.state = { mode: "search_preamble", window: "" };
        return {
          kind: "frame",
          frame: {
            text,
            version: "v2",
            compressed: finalized.compressed,
            lenBytes: finalized.lenBytes,
            seq: null,
          },
          message: "DONE v2. back to preamble search.",
        };
      } catch {
        return this.resync("decode_fail", "decode error, resync...");
      }
    }

    return this.resync("sync_lost", "unexpected decoder state, resync...");
  }
}
