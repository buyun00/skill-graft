import type { Config } from "tailwindcss";

const easeGraft = "cubic-bezier(0.16, 1, 0.3, 1)";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,mjs}",
    "./node_modules/graft-glass-ui/src/**/*.{js,ts,jsx,tsx,mdx}",
    "./vendor/graft-glass-ui/src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        page: "var(--gg-page)",
        surface: "var(--gg-surface)",
        panel: "var(--gg-panel)",
        ink: "rgba(var(--gg-ink-rgb), <alpha-value>)",
        accent: "rgba(var(--gg-accent-rgb), <alpha-value>)",
        motion: "rgba(var(--gg-motion-rgb), <alpha-value>)",
        success: "#5cd882",
        danger: "#ef4444",
        info: "#6da6f7",
        warning: "#f0b030",
      },
      fontFamily: {
        sans: [
          "var(--font-inter)",
          "-apple-system",
          "SF Pro Display",
          "SF Pro Text",
          "Inter Variable",
          "system-ui",
          "sans-serif",
        ],
        mono: ["Berkeley Mono", "ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
      borderRadius: {
        graft: "16px",
      },
      transitionTimingFunction: {
        graft: easeGraft,
      },
      keyframes: {
        borderSpin: {
          "0%": { transform: "rotate(0deg)" },
          to: { transform: "rotate(1turn)" },
        },
        cmdkIn: {
          "0%": { opacity: "0", transform: "scale(0.95) translateY(-8px)" },
          to: { opacity: "1", transform: "scale(1) translateY(0)" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          to: { opacity: "1" },
        },
        modalIn: {
          "0%": { transform: "scale(0.97) translateY(8px)", opacity: "0" },
          to: { transform: "scale(1) translateY(0)", opacity: "1" },
        },
        backdropIn: {
          "0%": { opacity: "0" },
          to: { opacity: "1" },
        },
        emptyOrb: {
          "0%, to": { transform: "scale(1)", opacity: "0.35" },
          "50%": { transform: "scale(1.08)", opacity: "0.6" },
        },
      },
      animation: {
        borderSpin: "borderSpin 9s linear infinite",
        cmdkIn: "cmdkIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
        fadeIn: "fadeIn 0.15s ease-out",
        modalIn: "modalIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
        backdropIn: "backdropIn 0.15s ease-out",
        emptyOrb: "emptyOrb 3s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
