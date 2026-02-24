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
import { RxBitDecoder } from "../lib/rxDecoder";
import type { DecoderStats } from "../lib/rxDecoder";
import type { SignalDiagnosis, SignalMetrics } from "../lib/signal";

const EPS = 1e-12;
const UI_UPDATE_MS = 100;
const MAX_SPECTRUM_HZ = 4000;
const TS_PROFILES: TsProfile[] = ["safe", "balanced", "fast"];

function goertzelPower(
  samples: Float32Array<ArrayBufferLike>,
  sampleRate: number,
  targetHz: number,
): number {
  const w = (2 * Math.PI * targetHz) / sampleRate;
  const cosw = Math.cos(w);
  const sinw = Math.sin(w);
  const coeff = 2 * cosw;

  let q0 = 0;
  let q1 = 0;
  let q2 = 0;

  for (let i = 0; i < samples.length; i++) {
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

function chooseBitByMultiWindow(
  samples: Float32Array<ArrayBufferLike>,
  sampleRate: number,
  f0: number,
  f1: number,
) {
  const n = samples.length;
  const windowLen = Math.max(64, Math.floor(n / 2));
  const centers = [Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75)];

  let best = {
    score: -Infinity,
    p0: 0,
    p1: 0,
  };

  for (let i = 0; i < centers.length; i++) {
    const center = centers[i];
    const start = Math.max(0, Math.min(n - windowLen, center - Math.floor(windowLen / 2)));
    const end = Math.min(n, start + windowLen);
    const view = samples.subarray(start, end);

    const p0 = goertzelPower(view, sampleRate, f0);
    const p1 = goertzelPower(view, sampleRate, f1);
    const score = Math.abs(p1 - p0);
    if (score > best.score) {
      best = { score, p0, p1 };
    }
  }

  return {
    p0: best.p0,
    p1: best.p1,
    bit: best.p1 > best.p0 ? "1" : "0",
    snr: Math.max(best.p0, best.p1) / (Math.min(best.p0, best.p1) + EPS),
  };
}

function stabilizeBit(bitWindow: string[], nextBit: string, maxLen = 8) {
  bitWindow.push(nextBit);
  if (bitWindow.length > maxLen) bitWindow.shift();

  const ones = bitWindow.reduce((acc, b) => acc + (b === "1" ? 1 : 0), 0);
  const zeros = bitWindow.length - ones;

  if (ones >= 5) return "1";
  if (zeros >= 5) return "0";
  return nextBit;
}

function initialDecoderStats(): DecoderStats {
  return {
    okFrames: 0,
    crcFail: 0,
    lenInvalid: 0,
    decodeFail: 0,
    syncLost: 0,
    resyncCount: 0,
    lastError: null,
  };
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
  const [devMode, setDevMode] = useState(false);
  const [allowV2Fallback, setAllowV2Fallback] = useState(false);

  const [decodedText, setDecodedText] = useState("");
  const [decodedLen, setDecodedLen] = useState<number | null>(null);
  const [decodedVersion, setDecodedVersion] = useState<"v2" | "v3" | null>(null);
  const [decodedSeq, setDecodedSeq] = useState<number | null>(null);
  const [decoderStats, setDecoderStats] = useState<DecoderStats>(initialDecoderStats);

  const audioRef = useRef<{
    ctx: AudioContext;
    stream: MediaStream;
    source: MediaStreamAudioSourceNode;
    analyser: AnalyserNode;
  } | null>(null);

  const rafRef = useRef<number | null>(null);

  const tdRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const tdFftRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const fdRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const lastSampleAtRef = useRef<number>(0);
  const lastUiUpdateAtRef = useRef<number>(0);
  const bitHistoryRef = useRef<string[]>([]);
  const decoderRef = useRef<RxBitDecoder>(new RxBitDecoder({ allowV2Fallback: false }));

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
    bitHistoryRef.current = [];
    setLastBit("");
    setDebug(null);
    setMetrics(null);
    setDiagnosis("no_input");
    setSpectrum(null);
    setStatus("idle");
  }, []);

  const resetDecoder = useCallback(() => {
    decoderRef.current = new RxBitDecoder({ allowV2Fallback });
    setDecoderStats(decoderRef.current.getStats());
  }, [allowV2Fallback]);

  async function startRx() {
    setDecodedText("");
    setDecodedLen(null);
    setDecodedVersion(null);
    setDecodedSeq(null);
    setStatus("request mic...");
    setLastBit("");
    setDebug(null);
    setMetrics(null);
    setDiagnosis("no_input");
    setSpectrum(null);
    bitHistoryRef.current = [];

    resetDecoder();

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

      const sample = chooseBitByMultiWindow(td, h.ctx.sampleRate, f0, f1);
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
        p0: sample.p0,
        p1: sample.p1,
        snr: sample.snr,
        toneDeltaDb,
        peakHz,
        peakDb,
        noiseFloorDb,
      };

      const now = h.ctx.currentTime;
      if (now - lastSampleAtRef.current >= Ts) {
        const steps = Math.floor((now - lastSampleAtRef.current) / Ts);
        lastSampleAtRef.current += steps * Ts;

        const stableBit = stabilizeBit(bitHistoryRef.current, sample.bit);
        setLastBit(stableBit);

        const event = decoderRef.current.consumeBit(stableBit);
        if (event) {
          if (event.kind === "status") {
            setStatus(event.message);
            if (typeof event.lenBytes === "number") {
              setDecodedLen(event.lenBytes);
            }
          }

          if (event.kind === "error") {
            setStatus(event.message);
          }

          if (event.kind === "frame") {
            setDecodedText(event.frame.text);
            setDecodedLen(event.frame.lenBytes);
            setDecodedVersion(event.frame.version);
            setDecodedSeq(event.frame.seq);
            setStatus(event.message);
          }

          setDecoderStats(decoderRef.current.getStats());
        }
      }

      const nowMs = performance.now();
      if (nowMs - lastUiUpdateAtRef.current >= UI_UPDATE_MS) {
        lastUiUpdateAtRef.current = nowMs;
        setDebug({ p0: sample.p0, p1: sample.p1, snr: sample.snr });
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

  useEffect(() => {
    if (!running) {
      resetDecoder();
    }
  }, [allowV2Fallback, running, resetDecoder]);

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
          f0={f0}Hz, f1={f1}Hz, Ts={Math.round(Ts * 1000)}ms (profile: {tsLabel}, proto: v3)
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

      <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12 }}>
          <input
            type="checkbox"
            checked={devMode}
            onChange={(e) => {
              const next = e.target.checked;
              setDevMode(next);
              if (!next) setAllowV2Fallback(false);
            }}
            style={{ marginRight: 6 }}
          />
          Developer mode
        </label>

        <label style={{ fontSize: 12, opacity: devMode ? 1 : 0.6 }}>
          <input
            type="checkbox"
            checked={allowV2Fallback}
            disabled={!devMode || running}
            onChange={(e) => setAllowV2Fallback(e.target.checked)}
            style={{ marginRight: 6 }}
          />
          V2 fallback decode
        </label>
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
        <div>
          Last frame: {decodedVersion ?? "-"}
          {decodedSeq !== null ? ` (seq=${decodedSeq})` : ""}
        </div>
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

      {devMode && (
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.9 }}>
          decoder: ok={decoderStats.okFrames} crcFail={decoderStats.crcFail} lenInvalid=
          {decoderStats.lenInvalid} decodeFail={decoderStats.decodeFail} syncLost=
          {decoderStats.syncLost} resync={decoderStats.resyncCount} lastError=
          {decoderStats.lastError ?? "-"}
        </div>
      )}

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
