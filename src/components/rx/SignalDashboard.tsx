import { useEffect, useRef } from "react";
import type { SignalDiagnosis, SignalMetrics } from "../../lib/signal";

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
        color: "#64748b",
        detail: "입력 레벨이 낮습니다. 마이크 거리와 볼륨을 올려보세요.",
      };
    case "ambient_noise":
      return {
        label: "Ambient Noise",
        color: "#ea580c",
        detail: "배경 소음 비중이 높아 FSK 톤 대비가 약합니다.",
      };
    case "likely_fsk":
      return {
        label: "Likely FSK",
        color: "#0f766e",
        detail: "톤 대비가 충분해 디코딩 가능성이 높습니다.",
      };
    case "mismatch_freq_or_timing":
      return {
        label: "Mismatch",
        color: "#1d4ed8",
        detail: "주파수 또는 Ts 프로파일 불일치 가능성이 있습니다.",
      };
    default:
      return {
        label: "Unknown",
        color: "#64748b",
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

  const levelPercent = metrics ? clamp((metrics.rmsDb - -90) / 70, 0, 1) * 100 : 0;
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

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    ctx.strokeStyle = "#e2e8f0";
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
      ctx.font = "12px Space Grotesk";
      ctx.fillText("No spectrum data yet.", 10, 20);
    } else {
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < spectrum.length; i++) {
        const hz = (i / (spectrum.length - 1)) * MAX_SPECTRUM_HZ;
        const x = hzToX(hz, cssWidth);
        const y = dbToY(spectrum[i], cssHeight);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
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
      ctx.font = "12px Space Grotesk";
      ctx.fillText(label, clamp(x + 4, 4, cssWidth - 48), 14);
    };

    drawToneMarker(f0, "#ef4444", "f0");
    drawToneMarker(f1, "#22c55e", "f1");

    if (metrics) {
      const peakX = hzToX(metrics.peakHz, cssWidth);
      const peakY = dbToY(metrics.peakDb, cssHeight);
      ctx.fillStyle = "#1d4ed8";
      ctx.beginPath();
      ctx.arc(peakX, peakY, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "#334155";
    ctx.font = "11px IBM Plex Mono";
    ctx.fillText("0 Hz", 4, cssHeight - 6);
    ctx.fillText("4 kHz", cssWidth - 40, cssHeight - 6);
  }, [f0, f1, metrics, spectrum]);

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-600">Input level</div>
        <div className="mono text-xs text-slate-700">{metrics ? `${metrics.rmsDb.toFixed(1)} dB` : "-"}</div>
      </div>

      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-200">
        <div
          className={running ? "h-full bg-teal-600" : "h-full bg-slate-400"}
          style={{ width: `${levelPercent}%`, transition: "width 100ms linear" }}
        />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span
          className="rounded-full px-2.5 py-1 text-[11px] font-bold text-white"
          style={{ background: diagnosisMeta.color }}
        >
          {diagnosisMeta.label}
        </span>
        <span className="text-xs text-slate-600">{diagnosisMeta.detail}</span>
      </div>

      <div ref={wrapRef} className="mt-3 min-h-[140px] rounded-lg border border-slate-200">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
