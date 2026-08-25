/** Design tokens mirrored from GRAFT Explore. */

export const color = {
  page: "#050506",
  surface: "#0a0a0c",
  panel: "#0c0c0e",
  accent: "#f08030",
  accentHi: "#f59a45",
  accentLo: "#e07628",
  success: "#5cd882",
  danger: "#ef4444",
  info: "#6da6f7",
  warning: "#f0b030",
  online: "#34d399",
} as const;

export const ease = {
  graft: "cubic-bezier(0.16, 1, 0.3, 1)",
} as const;

export const duration = {
  fast: 150,
  base: 200,
  slow: 300,
} as const;

export const glass = {
  bg: "hsla(0,0%,100%,0.05)",
  border: "hsla(0,0%,100%,0.08)",
  blur: "20px",
  radius: 16,
} as const;

export const lift = {
  card: "hover:-translate-y-[3px] active:translate-y-0 active:scale-[0.99] transition-all duration-300 ease-out",
  button:
    "hover:-translate-y-[1px] active:translate-y-0 transition-all duration-200",
} as const;
