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
    <div style={{ padding: 16, fontFamily: "system-ui" }}>
      <h2>FSK TX</h2>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleBuild();
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          type="text"
          placeholder="Enter text"
          style={{ flex: 1 }}
        />
        <button type="submit">Build Frame</button>
        <button type="button" onClick={handleSend}>
          Send (FSK)
        </button>
        <button type="button" onClick={stopAudio}>
          Stop Audio
        </button>
      </form>

      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {TS_PROFILES.map((profile) => (
          <button
            key={profile}
            type="button"
            onClick={() => setTsProfile(profile)}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid #d0d7de",
              background: tsProfile === profile ? "#111" : "#fff",
              color: tsProfile === profile ? "#fff" : "#111",
            }}
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
            onChange={(e) => setDevMode(e.target.checked)}
            style={{ marginRight: 6 }}
          />
          Developer mode
        </label>

        <button
          type="button"
          disabled={!devMode || protocolVersion === "v3"}
          onClick={() => setProtocolVersion("v3")}
          style={{ opacity: !devMode ? 0.6 : 1 }}
        >
          V3
        </button>
        <button
          type="button"
          disabled={!devMode || protocolVersion === "v2"}
          onClick={() => setProtocolVersion("v2")}
          style={{ opacity: !devMode ? 0.6 : 1 }}
          title={!devMode ? "Enable developer mode for legacy V2" : ""}
        >
          Legacy V2
        </button>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, opacity: 0.85 }}>
        Params: f0={params.f0}Hz, f1={params.f1}Hz, Ts={Math.round(Ts * 1000)}ms
        {" "}
        (profile: {profileLabel(tsProfile)}, protocol: {effectiveProtocolVersion})
      </div>

      <div style={{ marginTop: 8, fontSize: 12 }}>Status: {txStatus}</div>

      {frameInfo && (
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.9 }}>
          version={frameInfo.version} rawBytes={frameInfo.rawBytes} txBytes={frameInfo.txBytes}
          {" "}
          compressed={frameInfo.compressed ? "on" : "off"} saving={saving.toFixed(1)}%
          {frameInfo.version === "v3" ? ` seq=${frameInfo.seq} crc=0x${frameInfo.crc16.toString(16).padStart(4, "0")}` : ""}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <p style={{ margin: "8px 0 4px" }}>Payload bits:</p>
        <div style={{ wordBreak: "break-all", fontSize: 12 }}>
          {payloadBitsUI}
        </div>

        <p style={{ margin: "12px 0 4px" }}>Frame bits:</p>
        <div style={{ wordBreak: "break-all", fontSize: 12 }}>
          {frameBitsUI}
        </div>
      </div>
    </div>
  );
}
