"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  GRAFT_ACCENT,
  GRAFT_MOTION,
  accentRamp,
  onColor,
  rgbString,
} from "@/lib/color";

export type ThemeMode = "dark" | "light";

type ThemeValue = {
  mode: ThemeMode;
  accent: string;
  motion: string;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
  setAccent: (hex: string) => void;
  setMotion: (hex: string) => void;
  reset: () => void;
};

const ThemeContext = createContext<ThemeValue | null>(null);

const STORAGE_KEY = "gg-theme";

function readStored(): { mode?: ThemeMode; accent?: string; motion?: string } {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as {
      mode?: ThemeMode;
      accent?: string;
      motion?: string;
    };
  } catch {
    return {};
  }
}

function applyVars(mode: ThemeMode, accent: string, motion: string) {
  const root = document.documentElement;
  const { hi, lo } = accentRamp(accent);
  const dark = mode === "dark";
  const vars: Record<string, string> = {
    "--gg-page": dark ? "#050506" : "#efece6",
    "--gg-surface": dark ? "#0a0a0c" : "#f6f3ed",
    "--gg-panel": dark ? "#0c0c0e" : "#fffcf7",
    "--gg-ink-rgb": dark ? "255, 255, 255" : "20, 20, 22",
    "--gg-glass-rgb": "255, 255, 255",
    "--gg-glass-alpha": dark ? "0.05" : "0.58",
    "--gg-line-rgb": dark ? "255, 255, 255" : "20, 20, 22",
    "--gg-line-alpha": dark ? "0.08" : "0.09",
    "--gg-overlay": dark ? "rgba(0,0,0,0.55)" : "rgba(28, 22, 16, 0.32)",
    "--gg-sidebar": dark ? "rgba(8,8,10,0.55)" : "rgba(255,252,247,0.66)",
    "--gg-accent-rgb": rgbString(accent),
    "--gg-accent-hi": hi,
    "--gg-accent-lo": lo,
    "--gg-motion-rgb": rgbString(motion),
    "--gg-on-accent": onColor(accent),
    colorScheme: mode,
  };
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
  for (const [key, value] of Object.entries(vars)) {
    if (key === "colorScheme") continue;
    root.style.setProperty(key, value);
  }
}

export function ThemeProvider({
  children,
  defaultMode = "dark",
}: {
  children: ReactNode;
  defaultMode?: ThemeMode;
}) {
  const [mode, setModeState] = useState<ThemeMode>(defaultMode);
  const [accent, setAccentState] = useState(GRAFT_ACCENT);
  const [motion, setMotionState] = useState(GRAFT_MOTION);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = readStored();
    if (stored.mode === "light" || stored.mode === "dark") setModeState(stored.mode);
    if (stored.accent) setAccentState(stored.accent);
    if (stored.motion) setMotionState(stored.motion);
    setReady(true);
  }, []);

  useEffect(() => {
    applyVars(mode, accent, motion);
    if (!ready) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, accent, motion }));
  }, [mode, accent, motion, ready]);

  const setMode = useCallback((next: ThemeMode) => setModeState(next), []);
  const toggleMode = useCallback(
    () => setModeState((m) => (m === "dark" ? "light" : "dark")),
    [],
  );
  const setAccent = useCallback((hex: string) => {
    if (/^#?[0-9a-fA-F]{3,8}$/.test(hex)) {
      setAccentState(hex.startsWith("#") ? hex : `#${hex}`);
    }
  }, []);
  const setMotion = useCallback((hex: string) => {
    if (/^#?[0-9a-fA-F]{3,8}$/.test(hex)) {
      setMotionState(hex.startsWith("#") ? hex : `#${hex}`);
    }
  }, []);
  const reset = useCallback(() => {
    setModeState(defaultMode);
    setAccentState(GRAFT_ACCENT);
    setMotionState(GRAFT_MOTION);
  }, [defaultMode]);

  const value = useMemo(
    () => ({
      mode,
      accent,
      motion,
      setMode,
      toggleMode,
      setAccent,
      setMotion,
      reset,
    }),
    [mode, accent, motion, setMode, toggleMode, setAccent, setMotion, reset],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

export function themeStylePreview(mode: ThemeMode, accent: string, motion: string): CSSProperties {
  const { hi, lo } = accentRamp(accent);
  const dark = mode === "dark";
  return {
    ["--gg-page" as string]: dark ? "#050506" : "#efece6",
    ["--gg-surface" as string]: dark ? "#0a0a0c" : "#f6f3ed",
    ["--gg-panel" as string]: dark ? "#0c0c0e" : "#fffcf7",
    ["--gg-ink-rgb" as string]: dark ? "255, 255, 255" : "20, 20, 22",
    ["--gg-glass-rgb" as string]: "255, 255, 255",
    ["--gg-glass-alpha" as string]: dark ? "0.05" : "0.58",
    ["--gg-line-rgb" as string]: dark ? "255, 255, 255" : "20, 20, 22",
    ["--gg-line-alpha" as string]: dark ? "0.08" : "0.09",
    ["--gg-accent-rgb" as string]: rgbString(accent),
    ["--gg-accent-hi" as string]: hi,
    ["--gg-accent-lo" as string]: lo,
    ["--gg-motion-rgb" as string]: rgbString(motion),
    ["--gg-on-accent" as string]: onColor(accent),
  };
}
