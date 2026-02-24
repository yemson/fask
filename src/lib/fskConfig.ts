export const FSK_F0_HZ = 1200;
export const FSK_F1_HZ = 2200;

export type TsProfile = "safe" | "balanced" | "fast";

export const TS_PROFILE_MS: Record<TsProfile, number> = {
  safe: 120,
  balanced: 80,
  fast: 60,
};

export const DEFAULT_TS_PROFILE: TsProfile = "balanced";
export const LOCAL_STORAGE_TS_PROFILE_KEY = "fsk.ts_profile";

export function isTsProfile(value: string): value is TsProfile {
  return value === "safe" || value === "balanced" || value === "fast";
}

export function getTsSec(profile: TsProfile) {
  return TS_PROFILE_MS[profile] / 1000;
}

export function readTsProfileFromStorage(): TsProfile {
  if (typeof window === "undefined") return DEFAULT_TS_PROFILE;
  const raw = window.localStorage.getItem(LOCAL_STORAGE_TS_PROFILE_KEY);
  return raw && isTsProfile(raw) ? raw : DEFAULT_TS_PROFILE;
}

export function writeTsProfileToStorage(profile: TsProfile) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOCAL_STORAGE_TS_PROFILE_KEY, profile);
}
