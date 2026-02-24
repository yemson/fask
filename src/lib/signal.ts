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
