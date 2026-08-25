export const CATEGORY_RGB = {
  coding: "99,102,241",
  design: "244,63,94",
  research: "16,185,129",
  education: "245,158,11",
  business: "240,128,48",
  fitness: "132,204,22",
  health: "6,182,212",
  legal: "168,85,247",
  other: "148,163,184",
} as const;

export type CategorySlug = keyof typeof CATEGORY_RGB;

export function rgbOf(category?: string | null): string {
  if (!category) return "240,128,48";
  const key = category.toLowerCase() as CategorySlug;
  return CATEGORY_RGB[key] ?? "240,128,48";
}

export function rgba(rgb: string, alpha: number): string {
  return `rgba(${rgb},${alpha})`;
}
