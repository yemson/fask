import { inflateRaw } from "pako";
import {
  PREAMBLE_BITS_V2,
  SYNC_BITS_V2,
  bitStreamToBytes,
  parseLenFlagU16,
} from "./protocol";

const PREAMBLE_MATCH_MIN = 28;
const SYNC_MAX_ERRORS = 2;
const MAX_PAYLOAD_BYTES = 0x7fff;

const INVERTED_PREAMBLE_BITS = PREAMBLE_BITS_V2.split("")
  .map((b) => (b === "1" ? "0" : "1"))
  .join("");

type DecoderState =
  | { mode: "search_preamble"; window: string }
  | { mode: "search_sync"; window: string; invert: boolean }
  | { mode: "read_len"; bits: string; invert: boolean }
  | {
      mode: "read_payload";
      lenBytes: number;
      compressed: boolean;
      bits: string;
      invert: boolean;
    };

export type DecoderErrorCode = "len_invalid" | "decode_fail";

export type DecoderStats = {
  okFrames: number;
  lenInvalid: number;
  decodeFail: number;
  resyncCount: number;
  lastError: DecoderErrorCode | null;
};

export type DecoderFrame = {
  text: string;
  compressed: boolean;
  lenBytes: number;
};

export type DecoderEvent =
  | { kind: "status"; message: string; lenBytes?: number }
  | { kind: "error"; code: DecoderErrorCode; message: string }
  | { kind: "frame"; frame: DecoderFrame; message: string };

function flipBit(bit: string) {
  return bit === "1" ? "0" : "1";
}

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

export class RxBitDecoder {
  private state: DecoderState = { mode: "search_preamble", window: "" };

  private stats: DecoderStats = {
    okFrames: 0,
    lenInvalid: 0,
    decodeFail: 0,
    resyncCount: 0,
    lastError: null,
  };

  reset() {
    this.state = { mode: "search_preamble", window: "" };
  }

  getMode(): DecoderState["mode"] {
    return this.state.mode;
  }

  getStats(): DecoderStats {
    return { ...this.stats };
  }

  private resync(errorCode: DecoderErrorCode, message: string): DecoderEvent {
    this.stats.lastError = errorCode;
    this.stats.resyncCount += 1;
    if (errorCode === "len_invalid") this.stats.lenInvalid += 1;
    if (errorCode === "decode_fail") this.stats.decodeFail += 1;

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
      const w = pushWindow(this.state.window, SYNC_BITS_V2.length, bit);
      this.state = {
        mode: "search_sync",
        window: w,
        invert: this.state.invert,
      };

      if (w.length !== SYNC_BITS_V2.length) return null;

      const errors = hammingDistance(w, SYNC_BITS_V2);
      if (errors > SYNC_MAX_ERRORS) return null;

      this.state = {
        mode: "read_len",
        bits: "",
        invert: this.state.invert,
      };
      return { kind: "status", message: `sync ok (err=${errors}), read len...` };
    }

    if (this.state.mode === "read_len") {
      const bits = this.state.bits + bit;
      if (bits.length < 16) {
        this.state = {
          mode: "read_len",
          bits,
          invert: this.state.invert,
        };
        return null;
      }

      const { compressed, lenBytes } = parseLenFlagU16(bits);
      if (lenBytes > MAX_PAYLOAD_BYTES) {
        return this.resync("len_invalid", `invalid len=${lenBytes}, resync...`);
      }

      this.state = {
        mode: "read_payload",
        lenBytes,
        compressed,
        bits: "",
        invert: this.state.invert,
      };

      return {
        kind: "status",
        message: `len=${lenBytes} bytes (${compressed ? "compressed" : "raw"}), read payload...`,
        lenBytes,
      };
    }

    if (this.state.mode === "read_payload") {
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
        const text = decodePayload(bits.slice(0, needBits), this.state.compressed);
        this.stats.okFrames += 1;

        const frame: DecoderFrame = {
          text,
          compressed: this.state.compressed,
          lenBytes: this.state.lenBytes,
        };

        this.state = { mode: "search_preamble", window: "" };
        return {
          kind: "frame",
          frame,
          message: "DONE v2. back to preamble search.",
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return this.resync("decode_fail", `decode error (${reason}), resync...`);
      }
    }

    return null;
  }
}
