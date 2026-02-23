import { useCallback, useEffect, useRef, useState } from "react";

type RxState =
  | { mode: "search_preamble"; window: string }
  | { mode: "search_sync"; window: string }
  | { mode: "read_len"; bits: string }
  | { mode: "read_payload"; lenBytes: number; bits: string };

const PREAMBLE_BITS = "01".repeat(32); // 64 bits
const SYNC_BITS = "11110000".repeat(2); // 16 bits

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

// Goertzel: calculate power at target frequency from time-domain samples
function goertzelPower(
  samples: Float32Array<ArrayBuffer>,
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

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function RxPage() {
  // Should match TX values
  const f0 = 1200;
  const f1 = 2200;
  const Ts = 0.08; // 80ms / bit

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [lastBit, setLastBit] = useState<string>("");
  const [debug, setDebug] = useState<{ p0: number; p1: number; snr: number } | null>(
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

  // time-domain buffer
  const tdRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const lastSampleAtRef = useRef<number>(0);

  // protocol state machine
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

    source.connect(analyser);

    audioRef.current = { ctx, stream, source, analyser };

    // number of samples per Ts
    const N = Math.max(128, Math.round(ctx.sampleRate * Ts));
    tdRef.current = new Float32Array(N);

    lastSampleAtRef.current = ctx.currentTime;
    setRunning(true);
    setStatus("listening...");

    const loop = () => {
      const h = audioRef.current;
      const buf = tdRef.current;
      if (!h || !buf) return;

      // sample one bit every Ts
      const now = h.ctx.currentTime;
      if (now - lastSampleAtRef.current >= Ts) {
        lastSampleAtRef.current = now;

        h.analyser.getFloatTimeDomainData(buf);

        const p0 = goertzelPower(buf, h.ctx.sampleRate, f0);
        const p1 = goertzelPower(buf, h.ctx.sampleRate, f1);

        const eps = 1e-12;
        const snr = Math.max(p0, p1) / (Math.min(p0, p1) + eps);

        setDebug({ p0, p1, snr });

        // skip if too weak
        if (snr < 1.2) {
          setLastBit("");
        } else {
          const bit = p1 > p0 ? "1" : "0";
          setLastBit(bit);
          consumeBit(bit);
        }
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
