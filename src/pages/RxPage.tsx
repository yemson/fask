import { useCallback, useEffect, useRef, useState } from "react";
import SignalDashboard from "../components/rx/SignalDashboard";

type RxState =
  | { mode: "search_preamble"; window: string }
  | { mode: "search_sync"; window: string }
  | { mode: "read_len"; bits: string }
  | { mode: "read_payload"; lenBytes: number; bits: string };

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

const PREAMBLE_BITS = "01".repeat(32); // 64 bits
const SYNC_BITS = "11110000".repeat(2); // 16 bits
const EPS = 1e-12;
const UI_UPDATE_MS = 100;
const MAX_SPECTRUM_HZ = 4000;

function bitsToU16(bits16: string) {
  return parseInt(bits16, 2);
}

function bitsToBytes(bits: string): Uint8Array {
  if (bits.length % 8 !== 0) throw new Error("bits length not multiple of 8");
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    const chunk = bits.slice(i * 8, i * 8 + 8);
    out[i] = parseInt(chunk, 2);
  }
  return out;
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

export default function RxPage() {
  // Should match TX values.
  const f0 = 1200;
  const f1 = 2200;
  const Ts = 0.08; // 80ms / bit

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [lastBit, setLastBit] = useState<string>("");
  const [debug, setDebug] = useState<{ p0: number; p1: number; snr: number } | null>(
    null,
  );
  const [metrics, setMetrics] = useState<SignalMetrics | null>(null);
  const [diagnosis, setDiagnosis] = useState<SignalDiagnosis>("no_input");
  const [spectrum, setSpectrum] = useState<Float32Array<ArrayBuffer> | null>(null);

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
    fdRef.current = null;
    setLastBit("");
    setDebug(null);
    setMetrics(null);
    setDiagnosis("no_input");
    setSpectrum(null);
    setStatus("idle");
  }, []);

  function consumeBit(bit: string) {
    const st = rxStateRef.current;

    const pushWindow = (window: string, maxLen: number) => {
      return (window + bit).slice(-maxLen);
    };

    if (st.mode === "search_preamble") {
      const w = pushWindow(st.window, PREAMBLE_BITS.length);
      rxStateRef.current = { mode: "search_preamble", window: w };
      if (w === PREAMBLE_BITS) {
        setStatus("preamble ok, find sync...");
        rxStateRef.current = { mode: "search_sync", window: "" };
      }
      return;
    }

    if (st.mode === "search_sync") {
      const w = pushWindow(st.window, SYNC_BITS.length);
      rxStateRef.current = { mode: "search_sync", window: w };
      if (w === SYNC_BITS) {
        setStatus("sync ok, read len...");
        rxStateRef.current = { mode: "read_len", bits: "" };
      }
      return;
    }

    if (st.mode === "read_len") {
      const bits = st.bits + bit;
      if (bits.length < 16) {
        rxStateRef.current = { mode: "read_len", bits };
      } else {
        const lenBytes = bitsToU16(bits);
        setDecodedLen(lenBytes);
        setStatus(`len=${lenBytes} bytes, read payload...`);
        rxStateRef.current = { mode: "read_payload", lenBytes, bits: "" };
      }
      return;
    }

    if (st.mode === "read_payload") {
      const needBits = st.lenBytes * 8;
      const bits = st.bits + bit;

      if (bits.length < needBits) {
        rxStateRef.current = { mode: "read_payload", lenBytes: st.lenBytes, bits };
      } else {
        try {
          const payloadBits = bits.slice(0, needBits);
          const bytes = bitsToBytes(payloadBits);
          const text = new TextDecoder().decode(bytes);
          setDecodedText(text);
          setStatus("DONE. back to preamble search.");
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
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -120;
    analyser.maxDecibels = -10;

    source.connect(analyser);

    audioRef.current = { ctx, stream, source, analyser };

    // Number of samples per bit.
    const N = Math.max(128, Math.round(ctx.sampleRate * Ts));
    tdRef.current = new Float32Array(N);
    fdRef.current = new Float32Array(analyser.frequencyBinCount);

    lastSampleAtRef.current = ctx.currentTime;
    lastUiUpdateAtRef.current = 0;
    setRunning(true);
    setStatus("listening...");

    const loop = () => {
      const h = audioRef.current;
      const td = tdRef.current;
      const fd = fdRef.current;
      if (!h || !td || !fd) return;

      h.analyser.getFloatTimeDomainData(td);
      h.analyser.getFloatFrequencyData(fd);

      const p0 = goertzelPower(td, h.ctx.sampleRate, f0);
      const p1 = goertzelPower(td, h.ctx.sampleRate, f1);
      const snr = Math.max(p0, p1) / (Math.min(p0, p1) + EPS);

      const rmsDb = computeRmsDb(td);
      const noiseFloorDb = estimateNoiseFloorDb(fd, h.ctx.sampleRate, MAX_SPECTRUM_HZ);
      const { peakHz, peakDb } = findPeak(fd, h.ctx.sampleRate, MAX_SPECTRUM_HZ);
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
        lastSampleAtRef.current = now;

        if (snr < 1.2) {
          setLastBit("");
        } else {
          const bit = p1 > p0 ? "1" : "0";
          setLastBit(bit);
          consumeBit(bit);
        }
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

  return (
    <div style={{ padding: 16, fontFamily: "system-ui" }}>
      <h2>FSK RX</h2>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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
          f0={f0}Hz, f1={f1}Hz, Ts={Math.round(Ts * 1000)}ms
        </div>
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
            p0={debug.p0.toExponential(2)} p1={debug.p1.toExponential(2)}
            {" "}
            snr~{debug.snr.toFixed(2)}
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

      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
        Tip: test with a fixed pattern (1010...) from TX first, and check if
        "Last bit" alternates.
        <br />
        If not, try Ts=120ms or wider f0/f1 spacing (example: 1000/2500).
      </div>
    </div>
  );
}
