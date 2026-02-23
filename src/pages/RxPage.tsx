import { inflateRaw } from "pako";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SignalDashboard from "../components/rx/SignalDashboard";
import {
  FSK_F0_HZ,
  FSK_F1_HZ,
  TS_PROFILE_MS,
  getTsSec,
  readTsProfileFromStorage,
  writeTsProfileToStorage,
} from "../lib/fskConfig";
import type { TsProfile } from "../lib/fskConfig";
import { PREAMBLE_BITS_V2, SYNC_BITS_V2, parseLenFlagU16 } from "../lib/protocol";

type RxState =
  | { mode: "search_preamble"; window: string }
  | { mode: "search_sync"; window: string; invert: boolean }
  | { mode: "read_len"; bits: string; invert: boolean }
  | {
      mode: "read_payload";
      lenBytes: number;
      bits: string;
      invert: boolean;
      compressed: boolean;
    };

export type SignalMetrics = {
  rmsDb: number;
  p0: number;
  p1: number;
  snr: number;
  toneDeltaDb: number;
  peakHz: number;
  peakDb: number;
  noiseFloorDb: number;
};

export type SignalDiagnosis =
  | "no_input"
  | "ambient_noise"
  | "likely_fsk"
  | "mismatch_freq_or_timing";

const PREAMBLE_BITS = PREAMBLE_BITS_V2; // 32 bits
const SYNC_BITS = SYNC_BITS_V2; // 16 bits
const PREAMBLE_MATCH_MIN = 28; // allow <= 4 bit errors in preamble
const SYNC_MAX_ERRORS = 2; // allow <= 2 bit errors in sync
const MAX_PAYLOAD_BYTES = 0x7fff;
const EPS = 1e-12;
const UI_UPDATE_MS = 100;
const MAX_SPECTRUM_HZ = 4000;
const TS_PROFILES: TsProfile[] = ["safe", "balanced", "fast"];
const INVERTED_PREAMBLE_BITS = PREAMBLE_BITS.split("")
  .map((b) => (b === "1" ? "0" : "1"))
  .join("");

function bitsToBytes(bits: string): Uint8Array {
  if (bits.length % 8 !== 0) throw new Error("bits length not multiple of 8");
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    const chunk = bits.slice(i * 8, i * 8 + 8);
    out[i] = parseInt(chunk, 2);
  }
  return out;
}

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

// Goertzel: calculate power at target frequency from time-domain samples.
function goertzelPower(
  samples: Float32Array<ArrayBufferLike>,
  sampleRate: number,
  targetHz: number,
): number {
  const N = samples.length;
  const w = (2 * Math.PI * targetHz) / sampleRate;
  const cosw = Math.cos(w);
  const sinw = Math.sin(w);
  const coeff = 2 * cosw;

  let q0 = 0;
  let q1 = 0;
  let q2 = 0;

  for (let i = 0; i < N; i++) {
    q0 = coeff * q1 - q2 + samples[i];
    q2 = q1;
    q1 = q0;
  }

  const real = q1 - q2 * cosw;
  const imag = q2 * sinw;
  return real * real + imag * imag;
}

function computeRmsDb(samples: Float32Array<ArrayBufferLike>) {
  if (samples.length === 0) return -120;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sum / samples.length);
  return Math.max(-120, 20 * Math.log10(rms + EPS));
}

function maxBinForHz(binCount: number, sampleRate: number, maxHz: number) {
  const binHz = sampleRate / (2 * binCount);
  return Math.max(1, Math.min(binCount - 1, Math.floor(maxHz / binHz)));
}

function estimateNoiseFloorDb(
  spectrum: Float32Array<ArrayBufferLike>,
  sampleRate: number,
  maxHz: number,
) {
  const maxBin = maxBinForHz(spectrum.length, sampleRate, maxHz);
  const values: number[] = [];

  for (let i = 1; i <= maxBin; i++) {
    const v = spectrum[i];
    if (Number.isFinite(v)) values.push(v);
  }

  if (values.length === 0) return -120;

  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[mid];
  return (values[mid - 1] + values[mid]) / 2;
}

function findPeak(
  spectrum: Float32Array<ArrayBufferLike>,
  sampleRate: number,
  maxHz: number,
) {
  const maxBin = maxBinForHz(spectrum.length, sampleRate, maxHz);
  const binHz = sampleRate / (2 * spectrum.length);

  let peakDb = -Infinity;
  let peakBin = 1;
  for (let i = 1; i <= maxBin; i++) {
    const v = spectrum[i];
    if (Number.isFinite(v) && v > peakDb) {
      peakDb = v;
      peakBin = i;
    }
  }

  return {
    peakHz: peakBin * binHz,
    peakDb: Number.isFinite(peakDb) ? peakDb : -120,
  };
}

function getToneDb(
  spectrum: Float32Array<ArrayBufferLike>,
  sampleRate: number,
  targetHz: number,
) {
  const binHz = sampleRate / (2 * spectrum.length);
  const center = Math.round(targetHz / binHz);
  let out = -Infinity;

  for (let i = center - 1; i <= center + 1; i++) {
    if (i < 0 || i >= spectrum.length) continue;
    out = Math.max(out, spectrum[i]);
  }

  return Number.isFinite(out) ? out : -120;
}

function calcToneDeltaDb(
  spectrum: Float32Array<ArrayBufferLike>,
  sampleRate: number,
  f0: number,
  f1: number,
  noiseFloorDb: number,
) {
  const tone0Db = getToneDb(spectrum, sampleRate, f0);
  const tone1Db = getToneDb(spectrum, sampleRate, f1);
  const tonePeakDb = Math.max(tone0Db, tone1Db);
  return tonePeakDb - noiseFloorDb;
}

function sliceSpectrum(
  spectrum: Float32Array<ArrayBufferLike>,
  sampleRate: number,
  maxHz: number,
): Float32Array<ArrayBuffer> {
  const maxBin = maxBinForHz(spectrum.length, sampleRate, maxHz);
  const out = new Float32Array(maxBin + 1);
  out.set(spectrum.subarray(0, maxBin + 1));
  return out;
}

function diagnoseSignal(metrics: SignalMetrics): SignalDiagnosis {
  if (metrics.rmsDb < -58) return "no_input";
  if (metrics.rmsDb >= -58 && metrics.snr < 1.2 && metrics.toneDeltaDb < 8) {
    return "ambient_noise";
  }
  if (metrics.snr >= 1.2 && metrics.toneDeltaDb >= 8) {
    return "likely_fsk";
  }
  return "mismatch_freq_or_timing";
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function profileLabel(profile: TsProfile) {
  if (profile === "safe") return "Safe";
  if (profile === "balanced") return "Balanced";
  return "Fast";
}

function nextPowerOfTwo(n: number) {
  let v = 32;
  while (v < n && v < 32768) v *= 2;
  return v;
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

export default function RxPage() {
  const f0 = FSK_F0_HZ;
  const f1 = FSK_F1_HZ;

  const [tsProfile, setTsProfile] = useState<TsProfile>(() =>
    readTsProfileFromStorage(),
  );
  const Ts = getTsSec(tsProfile);

  useEffect(() => {
    writeTsProfileToStorage(tsProfile);
  }, [tsProfile]);

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [lastBit, setLastBit] = useState<string>("");
  const [debug, setDebug] = useState<{
    p0: number;
    p1: number;
    snr: number;
  } | null>(null);
  const [metrics, setMetrics] = useState<SignalMetrics | null>(null);
  const [diagnosis, setDiagnosis] = useState<SignalDiagnosis>("no_input");
  const [spectrum, setSpectrum] = useState<Float32Array<ArrayBuffer> | null>(
    null,
  );

  const [decodedText, setDecodedText] = useState("");
  const [decodedLen, setDecodedLen] = useState<number | null>(null);

  const audioRef = useRef<{
    ctx: AudioContext;
    stream: MediaStream;
    source: MediaStreamAudioSourceNode;
    analyser: AnalyserNode;
  } | null>(null);

  const rafRef = useRef<number | null>(null);

  // Analysis buffers.
  const tdRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const tdFftRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const fdRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const lastSampleAtRef = useRef<number>(0);
  const lastUiUpdateAtRef = useRef<number>(0);

  // Protocol state machine.
  const rxStateRef = useRef<RxState>({ mode: "search_preamble", window: "" });

  const stopRx = useCallback(async () => {
    setRunning(false);
    setStatus("stopping...");

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const h = audioRef.current;
    audioRef.current = null;

    try {
      if (h) {
        h.stream.getTracks().forEach((t) => t.stop());
        await h.ctx.close();
      }
    } catch {
      // ignore
    }

    tdRef.current = null;
    tdFftRef.current = null;
    fdRef.current = null;
    setLastBit("");
    setDebug(null);
    setMetrics(null);
    setDiagnosis("no_input");
    setSpectrum(null);
    setStatus("idle");
  }, []);

  function consumeBit(rawBit: string) {
    const st = rxStateRef.current;

    const pushWindow = (window: string, maxLen: number, nextBit: string) => {
      return (window + nextBit).slice(-maxLen);
    };

    if (st.mode === "search_preamble") {
      const w = pushWindow(st.window, PREAMBLE_BITS.length, rawBit);
      rxStateRef.current = { mode: "search_preamble", window: w };

      if (w.length === PREAMBLE_BITS.length) {
        const normalMatches = countMatches(w, PREAMBLE_BITS);
        const invertedMatches = countMatches(w, INVERTED_PREAMBLE_BITS);
        if (
          normalMatches >= PREAMBLE_MATCH_MIN ||
          invertedMatches >= PREAMBLE_MATCH_MIN
        ) {
          const invert = invertedMatches > normalMatches;
          const best = Math.max(normalMatches, invertedMatches);
          setStatus(`preamble ok (${best}/${PREAMBLE_BITS.length}), find sync...`);
          rxStateRef.current = { mode: "search_sync", window: "", invert };
        }
      }
      return;
    }

    const bit = st.invert ? flipBit(rawBit) : rawBit;

    if (st.mode === "search_sync") {
      const w = pushWindow(st.window, SYNC_BITS.length, bit);
      rxStateRef.current = {
        mode: "search_sync",
        window: w,
        invert: st.invert,
      };
      if (w.length === SYNC_BITS.length) {
        const errors = hammingDistance(w, SYNC_BITS);
        if (errors <= SYNC_MAX_ERRORS) {
          setStatus(`sync ok (err=${errors}), read len...`);
          rxStateRef.current = {
            mode: "read_len",
            bits: "",
            invert: st.invert,
          };
        }
      }
      return;
    }

    if (st.mode === "read_len") {
      const bits = st.bits + bit;
      if (bits.length < 16) {
        rxStateRef.current = { mode: "read_len", bits, invert: st.invert };
      } else {
        const { compressed, lenBytes } = parseLenFlagU16(bits);
        if (lenBytes > MAX_PAYLOAD_BYTES) {
          setDecodedLen(null);
          setStatus(`invalid len=${lenBytes}, resync...`);
          rxStateRef.current = { mode: "search_preamble", window: "" };
          return;
        }

        setDecodedLen(lenBytes);
        setStatus(
          `len=${lenBytes} bytes (${compressed ? "compressed" : "raw"}), read payload...`,
        );
        rxStateRef.current = {
          mode: "read_payload",
          lenBytes,
          bits: "",
          invert: st.invert,
          compressed,
        };
      }
      return;
    }

    if (st.mode === "read_payload") {
      const needBits = st.lenBytes * 8;
      const bits = st.bits + bit;

      if (bits.length < needBits) {
        rxStateRef.current = {
          mode: "read_payload",
          lenBytes: st.lenBytes,
          bits,
          invert: st.invert,
          compressed: st.compressed,
        };
      } else {
        try {
          const payloadBits = bits.slice(0, needBits);
          const payloadBytes = bitsToBytes(payloadBits);
          const decodedBytes = st.compressed
            ? normalizeInflatedBytes(inflateRaw(payloadBytes))
            : payloadBytes;
          const text = new TextDecoder().decode(decodedBytes);
          setDecodedText(text);
          setStatus(
            `DONE (${st.compressed ? "compressed payload" : "raw payload"}). back to preamble search.`,
          );
        } catch (error) {
          setStatus(`decode error: ${getErrorMessage(error)}`);
        } finally {
          rxStateRef.current = { mode: "search_preamble", window: "" };
        }
      }
    }
  }

  async function startRx() {
    setDecodedText("");
    setDecodedLen(null);
    setStatus("request mic...");
    setLastBit("");
    setDebug(null);
    setMetrics(null);
    setDiagnosis("no_input");
    setSpectrum(null);
    rxStateRef.current = { mode: "search_preamble", window: "" };

    const ctx = new AudioContext();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -120;
    analyser.maxDecibels = -10;

    source.connect(analyser);
    audioRef.current = { ctx, stream, source, analyser };

    // Number of samples in one bit window.
    const N = Math.max(128, Math.round(ctx.sampleRate * Ts));
    analyser.fftSize = nextPowerOfTwo(N);

    tdRef.current = new Float32Array(N);
    tdFftRef.current = new Float32Array(analyser.fftSize);
    fdRef.current = new Float32Array(analyser.frequencyBinCount);

    lastSampleAtRef.current = ctx.currentTime;
    lastUiUpdateAtRef.current = 0;
    setRunning(true);
    setStatus("listening...");

    const loop = () => {
      const h = audioRef.current;
      const td = tdRef.current;
      const tdFft = tdFftRef.current;
      const fd = fdRef.current;
      if (!h || !td || !tdFft || !fd) return;

      h.analyser.getFloatTimeDomainData(tdFft);
      td.set(tdFft.subarray(tdFft.length - td.length));
      h.analyser.getFloatFrequencyData(fd);

      const p0 = goertzelPower(td, h.ctx.sampleRate, f0);
      const p1 = goertzelPower(td, h.ctx.sampleRate, f1);
      const snr = Math.max(p0, p1) / (Math.min(p0, p1) + EPS);

      const rmsDb = computeRmsDb(td);
      const noiseFloorDb = estimateNoiseFloorDb(
        fd,
        h.ctx.sampleRate,
        MAX_SPECTRUM_HZ,
      );
      const { peakHz, peakDb } = findPeak(
        fd,
        h.ctx.sampleRate,
        MAX_SPECTRUM_HZ,
      );
      const toneDeltaDb = calcToneDeltaDb(
        fd,
        h.ctx.sampleRate,
        f0,
        f1,
        noiseFloorDb,
      );

      const nextMetrics: SignalMetrics = {
        rmsDb,
        p0,
        p1,
        snr,
        toneDeltaDb,
        peakHz,
        peakDb,
        noiseFloorDb,
      };

      // Keep bit decoding at Ts cadence.
      const now = h.ctx.currentTime;
      if (now - lastSampleAtRef.current >= Ts) {
        const steps = Math.floor((now - lastSampleAtRef.current) / Ts);
        lastSampleAtRef.current += steps * Ts;

        const bit = p1 > p0 ? "1" : "0";
        setLastBit(bit);
        consumeBit(bit);
      }

      // UI metrics/spectrum update every 100ms to reduce rerenders.
      const nowMs = performance.now();
      if (nowMs - lastUiUpdateAtRef.current >= UI_UPDATE_MS) {
        lastUiUpdateAtRef.current = nowMs;
        setDebug({ p0, p1, snr });
        setMetrics(nextMetrics);
        setDiagnosis(diagnoseSignal(nextMetrics));
        setSpectrum(sliceSpectrum(fd, h.ctx.sampleRate, MAX_SPECTRUM_HZ));
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
  }

  useEffect(() => {
    return () => {
      void stopRx();
    };
  }, [stopRx]);

  const tsLabel = useMemo(() => profileLabel(tsProfile), [tsProfile]);

  return (
    <div style={{ padding: 16, fontFamily: "system-ui" }}>
      <h2>FSK RX</h2>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {!running ? (
          <button
            onClick={async () => {
              try {
                await startRx();
              } catch (error) {
                setStatus(`start error: ${getErrorMessage(error)}`);
                await stopRx();
              }
            }}
          >
            Start RX (Mic)
          </button>
        ) : (
          <button onClick={stopRx}>Stop</button>
        )}

        <div style={{ fontSize: 12, opacity: 0.85 }}>
          f0={f0}Hz, f1={f1}Hz, Ts={Math.round(Ts * 1000)}ms (profile: {tsLabel})
        </div>
      </div>

      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {TS_PROFILES.map((profile) => (
          <button
            key={profile}
            type="button"
            disabled={running}
            onClick={() => setTsProfile(profile)}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid #d0d7de",
              background: tsProfile === profile ? "#111" : "#fff",
              color: tsProfile === profile ? "#fff" : "#111",
              opacity: running ? 0.7 : 1,
            }}
            title={running ? "Stop RX before changing Ts profile" : ""}
          >
            {profileLabel(profile)} {TS_PROFILE_MS[profile]}ms
          </button>
        ))}
      </div>

      <SignalDashboard
        running={running}
        f0={f0}
        f1={f1}
        metrics={metrics}
        diagnosis={diagnosis}
        spectrum={spectrum}
      />

      <div style={{ marginTop: 10 }}>
        <div>Status: {status}</div>
        <div>
          Last bit: <b>{lastBit || "-"}</b>
        </div>
        <div>LEN: {decodedLen ?? "-"}</div>
        {debug && (
          <div style={{ fontSize: 12, opacity: 0.85 }}>
            p0={debug.p0.toExponential(2)} p1={debug.p1.toExponential(2)} snr~
            {debug.snr.toFixed(2)}
          </div>
        )}
        {metrics && (
          <div style={{ fontSize: 12, opacity: 0.85 }}>
            rms={metrics.rmsDb.toFixed(1)}dB peak={Math.round(metrics.peakHz)}Hz
            peakDb={metrics.peakDb.toFixed(1)} noiseFloor=
            {metrics.noiseFloorDb.toFixed(1)} toneDelta=
            {metrics.toneDeltaDb.toFixed(1)}dB
          </div>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ marginBottom: 6 }}>Decoded text:</div>
        <pre
          style={{
            padding: 12,
            border: "1px solid #ddd",
            borderRadius: 8,
            whiteSpace: "pre-wrap",
          }}
        >
          {decodedText || "(none)"}
        </pre>
      </div>
    </div>
  );
}
