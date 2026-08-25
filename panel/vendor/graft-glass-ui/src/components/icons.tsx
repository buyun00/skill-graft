import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base(size: number, rest: SVGProps<SVGSVGElement>) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...rest,
  };
}

export function IconSearch({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)} viewBox="0 0 16 16">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L13 13" />
    </svg>
  );
}

export function IconPlus({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function IconChevron({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

export function IconExplore({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M10.6 5.4l-1.9 3.1-3.1 1.9 1.9-3.1 3.1-1.9z" fill="currentColor" fillOpacity="0.25" />
    </svg>
  );
}

export function IconSkills({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.5 6h5M5.5 9h3" />
    </svg>
  );
}

export function IconHeart({ size = 16, filled = false, ...rest }: IconProps & { filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.3"
      {...rest}
    >
      <path d="M8 13.5s-5-3.2-5-6.8a3.2 3.2 0 016.5-1 3.2 3.2 0 016.5 1c0 3.6-5 6.8-5 6.8z" />
    </svg>
  );
}

export function IconCart({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M5 5h8l-1 5.5H6L5 5z" />
      <path d="M5 5L4.5 3H2" />
      <circle cx="6.5" cy="13" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="11.5" cy="13" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconBag({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M2.5 5.2L8 2.5l5.5 2.7v5.6L8 13.5 2.5 10.8V5.2z" />
      <path d="M2.5 5.2L8 8l5.5-2.8M8 8v5.5" />
    </svg>
  );
}

export function IconUser({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <circle cx="8" cy="6" r="2.4" />
      <path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5" />
    </svg>
  );
}

export function IconClose({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)} strokeWidth={1.8}>
      <line x1="4" y1="4" x2="12" y2="12" />
      <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
  );
}

export function IconSignOut({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)} viewBox="0 0 16 16">
      <path d="M10 12l3-4-3-4M13 8H5M6 3H3v10h3" />
    </svg>
  );
}

export function IconFlame({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)} viewBox="0 0 24 24" strokeWidth={1.8}>
      <path d="M12 3c1.5 3 1 5-1 7 2 0 4 1.5 4 4.5a4.5 4.5 0 11-9 0c0-2 1-3.5 2-4.5 1 2 2 2 3 1.5C12.5 9 11 6 12 3z" />
    </svg>
  );
}

export function IconSpark({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)} viewBox="0 0 24 24" strokeWidth={1.8}>
      <path d="M12 4v6M12 14v6M4 12h6M14 12h6" />
    </svg>
  );
}

export function IconShield({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)} viewBox="0 0 24 24">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

export function IconBlocks({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)} viewBox="0 0 24 24">
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
      <path d="M11 7h4a2 2 0 012 2v4" />
    </svg>
  );
}

export function IconCoin({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v8M9.5 10.5c.6-.8 1.5-1.2 2.5-1.2 1.6 0 2.8 1 2.8 2.4s-1.2 2.4-2.8 2.4c-1 0-1.9-.4-2.5-1.2" />
    </svg>
  );
}

export function IconPublish({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)} viewBox="0 0 24 24">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

export function IconSpinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

export function IconHome({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M2.5 7.5L8 3l5.5 4.5V13a1.5 1.5 0 01-1.5 1.5H4A1.5 1.5 0 012.5 13V7.5z" />
      <path d="M6 14.5V9h4v5.5" />
    </svg>
  );
}

export function IconCube({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M8 2.5L13.5 5.5v5L8 13.5 2.5 10.5v-5L8 2.5z" />
      <path d="M2.5 5.5L8 8.5l5.5-3M8 8.5v5" />
    </svg>
  );
}

export function IconRefresh({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M13 8a5 5 0 11-1.4-3.4" />
      <path d="M13 3.5V6.5H10" />
    </svg>
  );
}

export function IconFolder({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M2.5 5.2A1.2 1.2 0 013.7 4h2.4l1.3 1.4h4.9A1.2 1.2 0 0113.5 6.6v5.2a1.2 1.2 0 01-1.2 1.2H3.7A1.2 1.2 0 012.5 11.8V5.2z" />
    </svg>
  );
}

export function IconStore({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M3 6.5L4 3.5h8L13 6.5" />
      <path d="M3 6.5h10v6A1.5 1.5 0 0111.5 14h-7A1.5 1.5 0 013 12.5v-6z" />
      <path d="M6.5 9.5h3" />
    </svg>
  );
}

export function IconSparkle({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M8 2.5l.9 3.1L12 6.5l-3.1.9L8 10.5l-.9-3.1L4 6.5l3.1-.9L8 2.5z" />
      <path d="M12.5 9.5l.4 1.4 1.4.4-1.4.4-.4 1.4-.4-1.4-1.4-.4 1.4-.4.4-1.4z" />
    </svg>
  );
}

export function IconGear({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 2.5v1.4M8 12.1v1.4M2.5 8h1.4M12.1 8h1.4M4.1 4.1l1 1M10.9 10.9l1 1M11.9 4.1l-1 1M5.1 10.9l-1 1" />
    </svg>
  );
}

export function IconBell({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M4 7.2a4 4 0 018 0c0 3.2 1.2 4.3 1.2 4.3H2.8S4 10.4 4 7.2z" />
      <path d="M6.6 12.8a1.5 1.5 0 002.8 0" />
    </svg>
  );
}

export function IconSun({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 2.4v1.3M8 12.3v1.3M2.4 8h1.3M12.3 8h1.3M4 4l.9.9M11.1 11.1l.9.9M12 4l-.9.9M4.9 11.1l-.9.9" />
    </svg>
  );
}

export function IconMoon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M10.5 3.2A5 5 0 106.8 13 4.2 4.2 0 1010.5 3.2z" />
    </svg>
  );
}

export function IconGit({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <circle cx="4.5" cy="11.5" r="1.5" />
      <circle cx="11.5" cy="11.5" r="1.5" />
      <circle cx="8" cy="4.5" r="1.5" />
      <path d="M4.5 10V8.2A1.7 1.7 0 016.2 6.5h3.6A1.7 1.7 0 0111.5 8.2V10M8 6.5V4.5" />
    </svg>
  );
}

export function IconDrive({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <rect x="2.5" y="5" width="11" height="7" rx="1.4" />
      <path d="M5 8.5h.01M7.5 8.5h3" />
    </svg>
  );
}

export function IconCheck({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M3.5 8.3l3 3.2 6-6.5" />
    </svg>
  );
}

export function IconWrench({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M10.2 3.2a3 3 0 013.6 3.6L9.2 11.4 6.6 8.8 10.2 3.2z" />
      <path d="M6.2 9.2L3.4 12a1.3 1.3 0 001.8 1.8l2.8-2.8" />
    </svg>
  );
}
