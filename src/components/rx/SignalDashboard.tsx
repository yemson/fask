import { useEffect, useRef } from "react";
import type { SignalDiagnosis, SignalMetrics } from "../../pages/RxPage";

type SignalDashboardProps = {
  running: boolean;
  f0: number;
  f1: number;
  metrics: SignalMetrics | null;
  diagnosis: SignalDiagnosis;
  spectrum: Float32Array<ArrayBuffer> | null;
};

const MAX_SPECTRUM_HZ = 4000;
const CHART_DB_MIN = -120;
const CHART_DB_MAX = -10;
const CHART_MIN_HEIGHT = 140;
const CHART_HEIGHT = 180;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function dbToY(db: number, height: number) {
  const ratio = clamp((db - CHART_DB_MIN) / (CHART_DB_MAX - CHART_DB_MIN), 0, 1);
  return height * (1 - ratio);
}

function hzToX(hz: number, width: number) {
  const ratio = clamp(hz / MAX_SPECTRUM_HZ, 0, 1);
  return ratio * width;
}

function getDiagnosisMeta(diagnosis: SignalDiagnosis) {
  switch (diagnosis) {
    case "no_input":
      return {
        label: "No Input",
        color: "#6b7280",
        detail: "Mic level is too low. Move closer or increase speaker volume.",
      };
    case "ambient_noise":
      return {
        label: "Ambient Noise",
        color: "#ea580c",
        detail: "Noise is present but FSK tones are not dominant.",
      };
    case "likely_fsk":
      return {
        label: "Likely FSK",
        color: "#16a34a",
        detail: "Tone contrast is strong enough for decoding.",
      };
    case "mismatch_freq_or_timing":
      return {
        label: "Mismatch",
        color: "#2563eb",
        detail: "Signal exists but frequency or timing likely differs.",
      };
    default:
      return {
        label: "Unknown",
        color: "#6b7280",
        detail: "",
      };
  }
}

export default function SignalDashboard({
  running,
  f0,
  f1,
  metrics,
  diagnosis,
  spectrum,
}: SignalDashboardProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const levelPercent = metrics
    ? clamp((metrics.rmsDb - -90) / 70, 0, 1) * 100
    : 0;
  const diagnosisMeta = getDiagnosisMeta(diagnosis);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const cssWidth = Math.max(280, Math.floor(wrap.clientWidth));
    const cssHeight = Math.max(CHART_MIN_HEIGHT, CHART_HEIGHT);
    const dpr = window.devicePixelRatio || 1;

    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    for (let hz = 0; hz <= MAX_SPECTRUM_HZ; hz += 500) {
      const x = hzToX(hz, cssWidth);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssHeight);
      ctx.stroke();
    }

    const dbTicks = [-120, -90, -60, -30, -10];
    for (const db of dbTicks) {
      const y = dbToY(db, cssHeight);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cssWidth, y);
      ctx.stroke();
    }

    if (!spectrum || spectrum.length < 2) {
      ctx.fillStyle = "#64748b";
      ctx.font = "12px system-ui";
      ctx.fillText("No spectrum data yet.", 10, 20);
    } else {
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < spectrum.length; i++) {
        const hz = (i / (spectrum.length - 1)) * MAX_SPECTRUM_HZ;
        const x = hzToX(hz, cssWidth);
        const y = dbToY(spectrum[i], cssHeight);
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    const drawToneMarker = (hz: number, color: string, label: string) => {
      const x = hzToX(hz, cssWidth);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssHeight);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.font = "12px system-ui";
      ctx.fillText(label, clamp(x + 4, 4, cssWidth - 48), 14);
    };

    drawToneMarker(f0, "#ef4444", "f0");
    drawToneMarker(f1, "#22c55e", "f1");

    if (metrics) {
      const peakX = hzToX(metrics.peakHz, cssWidth);
      const peakY = dbToY(metrics.peakDb, cssHeight);
      ctx.fillStyle = "#2563eb";
      ctx.beginPath();
      ctx.arc(peakX, peakY, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "#334155";
    ctx.font = "11px system-ui";
    ctx.fillText("0 Hz", 4, cssHeight - 6);
    ctx.fillText("4 kHz", cssWidth - 34, cssHeight - 6);
  }, [f0, f1, metrics, spectrum]);

  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        border: "1px solid #dbe2ea",
        borderRadius: 10,
        background: "#ffffff",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Input level (dBFS)</div>
        <div style={{ fontSize: 12, color: "#475569" }}>
          {metrics ? `${metrics.rmsDb.toFixed(1)} dB` : "-"}
        </div>
      </div>

      <div
        style={{
          marginTop: 8,
          width: "100%",
          height: 10,
          background: "#e2e8f0",
          borderRadius: 999,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${levelPercent}%`,
            height: "100%",
            background: running ? "#2563eb" : "#94a3b8",
            transition: "width 100ms linear",
          }}
        />
      </div>

      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            display: "inline-block",
            padding: "4px 8px",
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 700,
            color: "#ffffff",
            background: diagnosisMeta.color,
          }}
        >
          {diagnosisMeta.label}
        </span>
        <span style={{ fontSize: 12, color: "#475569" }}>{diagnosisMeta.detail}</span>
      </div>

      <div ref={wrapRef} style={{ marginTop: 12, minHeight: CHART_MIN_HEIGHT }}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
