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

const MIN_DECODE_RMS_DB = -58;
const MIN_DECODE_SNR = 1.2;
const MIN_DECODE_TONE_DELTA_DB = 8;

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
  return Math.max(tone0Db, tone1Db) - noiseFloorDb;
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

function initialDecoderStats(): DecoderStats {
  return {
    okFrames: 0,
    lenInvalid: 0,
    decodeFail: 0,
    resyncCount: 0,
    lastError: null,
  };
}

function cardClass() {
  return "rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-5 shadow-lg shadow-slate-200/60 backdrop-blur";
}

function chipClass(active: boolean) {
  return [
    "rounded-full border px-3 py-1.5 text-xs font-semibold transition",
    active
      ? "border-teal-700 bg-teal-700 text-white"
      : "border-slate-300 bg-white text-slate-700 hover:border-teal-600 hover:text-teal-700",
  ].join(" ");
}

export default function RxPage() {
  const [tsProfile, setTsProfile] = useState<TsProfile>(() => readTsProfileFromStorage());
  const Ts = getTsSec(tsProfile);

  useEffect(() => {
    writeTsProfileToStorage(tsProfile);
  }, [tsProfile]);

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [lastBit, setLastBit] = useState<string>("");
  const [decodedText, setDecodedText] = useState("");
  const [decodedLen, setDecodedLen] = useState<number | null>(null);
  const [decoderStats, setDecoderStats] = useState<DecoderStats>(initialDecoderStats);

  const [debug, setDebug] = useState<{
    p0: number;
    p1: number;
    snr: number;
  } | null>(null);
  const [metrics, setMetrics] = useState<SignalMetrics | null>(null);
  const [diagnosis, setDiagnosis] = useState<SignalDiagnosis>("no_input");
  const [spectrum, setSpectrum] = useState<Float32Array<ArrayBuffer> | null>(null);

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

  const decoderRef = useRef<RxBitDecoder>(new RxBitDecoder());
  const weakSignalGateRef = useRef(false);

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
    weakSignalGateRef.current = false;

    setLastBit("");
    setDebug(null);
    setMetrics(null);
    setDiagnosis("no_input");
    setSpectrum(null);
    setStatus("idle");
  }, []);

  const resetDecoder = useCallback(() => {
    decoderRef.current = new RxBitDecoder();
    setDecoderStats(decoderRef.current.getStats());
  }, []);

  async function startRx() {
    setDecodedText("");
    setDecodedLen(null);
    setStatus("request mic...");
    setLastBit("");
    setDebug(null);
    setMetrics(null);
    setDiagnosis("no_input");
    setSpectrum(null);

    resetDecoder();
    weakSignalGateRef.current = false;

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

    const sampleCount = Math.max(128, Math.round(ctx.sampleRate * Ts));
    analyser.fftSize = nextPowerOfTwo(sampleCount);

    tdRef.current = new Float32Array(sampleCount);
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

      const p0 = goertzelPower(td, h.ctx.sampleRate, FSK_F0_HZ);
      const p1 = goertzelPower(td, h.ctx.sampleRate, FSK_F1_HZ);
      const snr = Math.max(p0, p1) / (Math.min(p0, p1) + EPS);
      const bit = p1 > p0 ? "1" : "0";

      const rmsDb = computeRmsDb(td);
      const noiseFloorDb = estimateNoiseFloorDb(fd, h.ctx.sampleRate, MAX_SPECTRUM_HZ);
      const { peakHz, peakDb } = findPeak(fd, h.ctx.sampleRate, MAX_SPECTRUM_HZ);
      const toneDeltaDb = calcToneDeltaDb(
        fd,
        h.ctx.sampleRate,
        FSK_F0_HZ,
        FSK_F1_HZ,
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

      const canDecodeSymbol =
        nextMetrics.rmsDb >= MIN_DECODE_RMS_DB &&
        nextMetrics.snr >= MIN_DECODE_SNR &&
        nextMetrics.toneDeltaDb >= MIN_DECODE_TONE_DELTA_DB;

      const now = h.ctx.currentTime;
      if (now - lastSampleAtRef.current >= Ts) {
        const steps = Math.floor((now - lastSampleAtRef.current) / Ts);
        if (steps > 1) {
          // Decoder should consume one fresh symbol per cycle to avoid duplicated stale bits.
          lastSampleAtRef.current = now;
        } else {
          lastSampleAtRef.current += Ts;
        }

        if (!canDecodeSymbol) {
          setLastBit("-");

          if (!weakSignalGateRef.current) {
            weakSignalGateRef.current = true;
            if (decoderRef.current.getMode() !== "search_preamble") {
              decoderRef.current.reset();
              setStatus("signal weak/noisy, decoder reset. waiting preamble...");
            } else {
              setStatus("signal weak/noisy, waiting clean tone...");
            }
          }
        } else {
          if (weakSignalGateRef.current) {
            weakSignalGateRef.current = false;
            setStatus("signal recovered, searching preamble...");
          }

          const event = decoderRef.current.consumeBit(bit);
          setLastBit(bit);

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
              setStatus(event.message);
            }

            setDecoderStats(decoderRef.current.getStats());
          }
        }
      }

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
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className={cardClass()}>
        <h2 className="mb-4 text-xl font-bold text-slate-900">FSK RX (V2)</h2>

        <div className="flex flex-wrap items-center gap-2">
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
              className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
            >
              Start RX
            </button>
          ) : (
            <button
              onClick={stopRx}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800"
            >
              Stop
            </button>
          )}

          <span className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700">
            f0={FSK_F0_HZ}Hz f1={FSK_F1_HZ}Hz Ts={Math.round(Ts * 1000)}ms ({tsLabel}, v2)
          </span>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {TS_PROFILES.map((profile) => (
            <button
              key={profile}
              type="button"
              disabled={running}
              onClick={() => setTsProfile(profile)}
              className={chipClass(tsProfile === profile)}
              title={running ? "Stop RX before changing Ts profile" : ""}
            >
              {profileLabel(profile)} {TS_PROFILE_MS[profile]}ms
            </button>
          ))}
        </div>

        <SignalDashboard
          running={running}
          f0={FSK_F0_HZ}
          f1={FSK_F1_HZ}
          metrics={metrics}
          diagnosis={diagnosis}
          spectrum={spectrum}
        />
      </div>

      <div className={cardClass()}>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Decoder</h3>

        <div className="mt-4 grid gap-2 text-sm">
          <div className="rounded-xl border border-slate-200 bg-white p-3">Status: {status}</div>
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            Last bit: <b>{lastBit || "-"}</b>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3">LEN: {decodedLen ?? "-"}</div>
        </div>

        {debug && (
          <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-700">
            p0={debug.p0.toExponential(2)} p1={debug.p1.toExponential(2)} snr~{debug.snr.toFixed(2)}
          </div>
        )}

        {metrics && (
          <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-700">
            rms={metrics.rmsDb.toFixed(1)}dB peak={Math.round(metrics.peakHz)}Hz peakDb={metrics.peakDb.toFixed(1)}
            noiseFloor={metrics.noiseFloorDb.toFixed(1)} toneDelta={metrics.toneDeltaDb.toFixed(1)}dB
          </div>
        )}

        <div className="mt-3 rounded-xl border border-orange-200 bg-orange-50 p-3 text-xs text-orange-900">
          ok={decoderStats.okFrames} lenInvalid={decoderStats.lenInvalid} decodeFail={decoderStats.decodeFail} resync=
          {decoderStats.resyncCount} lastError={decoderStats.lastError ?? "-"}
        </div>

        <div className="mt-4">
          <div className="mb-2 text-sm font-semibold text-slate-600">Decoded text</div>
          <pre className="mono min-h-40 whitespace-pre-wrap rounded-xl border border-slate-200 bg-white p-3 text-[12px] text-slate-700">
            {decodedText || "(none)"}
          </pre>
        </div>
      </div>
    </section>
  );
}
