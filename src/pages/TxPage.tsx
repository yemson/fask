import { useMemo, useRef, useState } from "react";

export default function TxPage() {
  const [inputValue, setInputValue] = useState("");
  const [payloadBitsUI, setPayloadBitsUI] = useState("");
  const [frameBitsUI, setFrameBitsUI] = useState("");

  // Encoding (text -> bytes -> bits)
  const textToBytes = (text: string): Uint8Array =>
    new TextEncoder().encode(text);

  // MSB-first bits
  const bytesToBitStream = (bytes: Uint8Array): string =>
    Array.from(bytes, (b) => b.toString(2).padStart(8, "0")).join("");

  const u16ToBits = (n: number): string => {
    if (!Number.isInteger(n) || n < 0 || n > 0xffff)
      throw new Error(`LEN out of range: ${n}`);
    return n.toString(2).padStart(16, "0");
  };

  // [PREAMBLE(64b)][SYNC(16b)][LEN(16b, BYTES)][PAYLOAD(bits)]
  const makeFrameBits = (
    payloadBits: string,
    payloadByteLen: number,
  ): string => {
    const preamble = "01".repeat(32); // 64 bits
    const sync = "11110000".repeat(2); // 16 bits
    const lenBits = u16ToBits(payloadByteLen); // 16 bits
    const frame = `${preamble}${sync}${lenBits}${payloadBits}`;

    const bad = frame.match(/[^01]/);
    if (bad) throw new Error(`Frame contains non-bit char: "${bad[0]}"`);
    if (payloadBits.length % 8 !== 0)
      throw new Error("payloadBits must be multiple of 8");

    return frame;
  };

  // FSK TX (bits -> sound)
  const audioRef = useRef<{
    ctx: AudioContext;
    osc: OscillatorNode;
    gain: GainNode;
  } | null>(null);

  const params = useMemo(
    () => ({
      f0: 1200,
      f1: 2200,
      Ts: 0.08, // 60ms per bit
      fade: 0.004, // 4ms fade to reduce clicks
      volume: 0.08, // quiet
    }),
    [],
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
    // Start slightly later for stable scheduling
    const t0 = now + 0.05;

    // Prepare gain automation
    h.gain.gain.cancelScheduledValues(now);
    h.gain.gain.setValueAtTime(0, now);

    // Prepare frequency automation
    h.osc.frequency.cancelScheduledValues(now);

    // Schedule one oscillator and switch freq per bit
    for (let i = 0; i < bits.length; i++) {
      const b = bits.charCodeAt(i); // '0' or '1'
      const freq = b === 49 ? f1 : f0;
      const t = t0 + i * Ts;

      h.osc.frequency.setValueAtTime(freq, t);

      // Short fade in/out per symbol to reduce clicks
      const tInEnd = t + fade;
      const tOutStart = t + Ts - fade;

      h.gain.gain.setValueAtTime(0, t);
      h.gain.gain.linearRampToValueAtTime(volume, tInEnd);
      h.gain.gain.setValueAtTime(volume, tOutStart);
      h.gain.gain.linearRampToValueAtTime(0, t + Ts);
    }

    const endTime = t0 + bits.length * Ts + 0.05;
    h.gain.gain.setValueAtTime(0, endTime);

    console.log(
      "TX scheduled bits:",
      bits.length,
      "duration(s):",
      bits.length * Ts,
    );
  };

  const handleBuild = () => {
    const bytes = textToBytes(inputValue);
    const payloadBits = bytesToBitStream(bytes);
    const frameBits = makeFrameBits(payloadBits, bytes.length);

    setPayloadBitsUI(payloadBits);
    setFrameBitsUI(frameBits);

    console.log("bytes.length =", bytes.length);
    console.log("payloadBits.length =", payloadBits.length);
    console.log("frameBits.length =", frameBits.length);
    console.log("frameBits head =", frameBits.slice(0, 120));
  };

  const handleSend = async () => {
    if (!frameBitsUI) handleBuild();
    const bits =
      frameBitsUI ||
      makeFrameBits(
        bytesToBitStream(textToBytes(inputValue)),
        textToBytes(inputValue).length,
      );

    await playFrameBitsFSK(bits);
  };

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

      <div style={{ marginTop: 12, fontSize: 12, opacity: 0.8 }}>
        Params: f0={params.f0}Hz, f1={params.f1}Hz, Ts={params.Ts * 1000}ms/bit
      </div>

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
