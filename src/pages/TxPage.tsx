import { useEffect, useMemo, useRef, useState } from "react";
import {
  FSK_F0_HZ,
  FSK_F1_HZ,
  TS_PROFILE_MS,
  getTsSec,
  readProtocolVersionFromStorage,
  readTsProfileFromStorage,
  writeProtocolVersionToStorage,
  writeTsProfileToStorage,
} from "../lib/fskConfig";
import type { ProtocolVersion, TsProfile } from "../lib/fskConfig";
import { buildFrameBitsV2, buildFrameBitsV3 } from "../lib/protocol";
import type { EncodedFrame } from "../lib/protocol";

const TS_PROFILES: TsProfile[] = ["safe", "balanced", "fast"];

function profileLabel(profile: TsProfile) {
  if (profile === "safe") return "Safe";
  if (profile === "balanced") return "Balanced";
  return "Fast";
}

function calcSavingPercent(rawBytes: number, txBytes: number) {
  if (rawBytes <= 0) return 0;
  return Math.max(0, ((rawBytes - txBytes) / rawBytes) * 100);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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

function buttonClass(kind: "primary" | "sub" = "sub") {
  return kind === "primary"
    ? "rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
    : "rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:border-teal-600 hover:text-teal-700";
}

export default function TxPage() {
  const [inputValue, setInputValue] = useState("");
  const [payloadBitsUI, setPayloadBitsUI] = useState("");
  const [frameBitsUI, setFrameBitsUI] = useState("");
  const [frameInfo, setFrameInfo] = useState<EncodedFrame | null>(null);
  const [txStatus, setTxStatus] = useState("idle");
  const [devMode, setDevMode] = useState(false);
  const [protocolVersion, setProtocolVersion] = useState<ProtocolVersion>(() =>
    readProtocolVersionFromStorage(),
  );
  const [tsProfile, setTsProfile] = useState<TsProfile>(() =>
    readTsProfileFromStorage(),
  );

  const seqRef = useRef(0);

  useEffect(() => {
    writeTsProfileToStorage(tsProfile);
  }, [tsProfile]);

  useEffect(() => {
    writeProtocolVersionToStorage(devMode ? protocolVersion : "v3");
  }, [devMode, protocolVersion]);

  const effectiveProtocolVersion: ProtocolVersion = devMode ? protocolVersion : "v3";

  const audioRef = useRef<{
    ctx: AudioContext;
    osc: OscillatorNode;
    gain: GainNode;
  } | null>(null);

  const Ts = getTsSec(tsProfile);
  const params = useMemo(
    () => ({
      f0: FSK_F0_HZ,
      f1: FSK_F1_HZ,
      Ts,
      fade: 0.004,
      volume: 0.08,
    }),
    [Ts],
  );

  const ensureAudio = () => {
    if (audioRef.current) return audioRef.current;

    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.type = "sine";

    const gain = ctx.createGain();
    gain.gain.value = 0;

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();

    audioRef.current = { ctx, osc, gain };
    return audioRef.current;
  };

  const stopAudio = async () => {
    const h = audioRef.current;
    audioRef.current = null;
    if (!h) return;

    try {
      h.osc.stop();
    } catch {
      console.error("Failed to stop oscillator");
    }
    try {
      await h.ctx.close();
    } catch {
      console.error("Failed to close audio context");
    }
  };

  const playFrameBitsFSK = async (bits: string) => {
    const h = ensureAudio();
    await h.ctx.resume();

    const { f0, f1, Ts, fade, volume } = params;
    const now = h.ctx.currentTime;
    const t0 = now + 0.05;

    h.gain.gain.cancelScheduledValues(now);
    h.gain.gain.setValueAtTime(0, now);
    h.osc.frequency.cancelScheduledValues(now);

    for (let i = 0; i < bits.length; i++) {
      const b = bits.charCodeAt(i);
      const freq = b === 49 ? f1 : f0;
      const t = t0 + i * Ts;

      h.osc.frequency.setValueAtTime(freq, t);

      const tInEnd = t + fade;
      const tOutStart = t + Ts - fade;
      h.gain.gain.setValueAtTime(0, t);
      h.gain.gain.linearRampToValueAtTime(volume, tInEnd);
      h.gain.gain.setValueAtTime(volume, tOutStart);
      h.gain.gain.linearRampToValueAtTime(0, t + Ts);
    }

    const endTime = t0 + bits.length * Ts + 0.05;
    h.gain.gain.setValueAtTime(0, endTime);
  };

  const buildFrame = (text: string) => {
    const encoded =
      effectiveProtocolVersion === "v3"
        ? buildFrameBitsV3(text, seqRef.current++)
        : buildFrameBitsV2(text);

    setFrameInfo(encoded);
    setFrameBitsUI(encoded.bits);
    setPayloadBitsUI(encoded.payloadBits);

    const saving = calcSavingPercent(encoded.rawBytes, encoded.txBytes);
    const mode = encoded.compressed ? "compressed" : "raw";
    if (encoded.version === "v3") {
      setTxStatus(
        `frame ready (v3 seq=${encoded.seq}, ${mode}, ${encoded.txBytes}/${encoded.rawBytes}B, save ${saving.toFixed(1)}%)`,
      );
    } else {
      setTxStatus(
        `frame ready (v2 ${mode}, ${encoded.txBytes}/${encoded.rawBytes}B, save ${saving.toFixed(1)}%)`,
      );
    }

    return encoded;
  };

  const handleBuild = () => {
    try {
      buildFrame(inputValue);
    } catch (error) {
      setTxStatus(`build error: ${getErrorMessage(error)}`);
    }
  };

  const handleSend = async () => {
    try {
      const encoded = buildFrame(inputValue);
      await playFrameBitsFSK(encoded.bits);
      setTxStatus(
        `sent ${encoded.bits.length} bits in ${(encoded.bits.length * Ts).toFixed(2)}s (${encoded.version}, ${encoded.compressed ? "compressed" : "raw"})`,
      );
    } catch (error) {
      setTxStatus(`send error: ${getErrorMessage(error)}`);
    }
  };

  const saving = frameInfo ? calcSavingPercent(frameInfo.rawBytes, frameInfo.txBytes) : 0;

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div className={cardClass()}>
        <h2 className="mb-4 text-xl font-bold text-slate-900">FSK TX</h2>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleBuild();
          }}
          className="flex flex-col gap-2 sm:flex-row"
        >
          <input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            type="text"
            placeholder="전송할 텍스트를 입력하세요"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-teal-500 focus:ring"
          />
          <button type="submit" className={buttonClass("sub")}>
            Build
          </button>
          <button type="button" onClick={handleSend} className={buttonClass("primary")}>
            Send
          </button>
          <button type="button" onClick={stopAudio} className={buttonClass("sub")}>
            Stop
          </button>
        </form>

        <div className="mt-4 flex flex-wrap gap-2">
          {TS_PROFILES.map((profile) => (
            <button
              key={profile}
              type="button"
              onClick={() => setTsProfile(profile)}
              className={chipClass(tsProfile === profile)}
            >
              {profileLabel(profile)} {TS_PROFILE_MS[profile]}ms
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-700">
          <label className="flex items-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-1.5">
            <input type="checkbox" checked={devMode} onChange={(e) => setDevMode(e.target.checked)} />
            Developer mode
          </label>

          <button
            type="button"
            disabled={!devMode || protocolVersion === "v3"}
            onClick={() => setProtocolVersion("v3")}
            className={chipClass(effectiveProtocolVersion === "v3")}
          >
            V3
          </button>
          <button
            type="button"
            disabled={!devMode || protocolVersion === "v2"}
            onClick={() => setProtocolVersion("v2")}
            className={chipClass(effectiveProtocolVersion === "v2")}
            title={!devMode ? "Enable developer mode for legacy V2" : ""}
          >
            Legacy V2
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-700">
          <p>
            Params: f0={params.f0}Hz, f1={params.f1}Hz, Ts={Math.round(Ts * 1000)}ms
          </p>
          <p className="mt-1">Profile: {profileLabel(tsProfile)} | Protocol: {effectiveProtocolVersion}</p>
          <p className="mt-1 font-semibold text-slate-900">Status: {txStatus}</p>
        </div>

        {frameInfo && (
          <div className="mt-3 rounded-xl border border-teal-200 bg-teal-50 p-3 text-xs text-teal-900">
            version={frameInfo.version} rawBytes={frameInfo.rawBytes} txBytes={frameInfo.txBytes} compressed=
            {frameInfo.compressed ? "on" : "off"} saving={saving.toFixed(1)}%
            {frameInfo.version === "v3"
              ? ` seq=${frameInfo.seq} crc=0x${frameInfo.crc16.toString(16).padStart(4, "0")}`
              : ""}
          </div>
        )}
      </div>

      <div className={cardClass()}>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Frame Inspector</h3>

        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold text-slate-600">Payload bits</p>
          <pre className="mono max-h-40 overflow-auto rounded-xl border border-slate-200 bg-white p-3 text-[11px] text-slate-700">
            {payloadBitsUI || "(none)"}
          </pre>
        </div>

        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold text-slate-600">Frame bits</p>
          <pre className="mono max-h-[22rem] overflow-auto rounded-xl border border-slate-200 bg-white p-3 text-[11px] text-slate-700">
            {frameBitsUI || "(none)"}
          </pre>
        </div>
      </div>
    </section>
  );
}
