"use client";

import type { ReactNode } from "react";
import { ThemeProvider, ToastProvider } from "graft-glass-ui/src/components";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider defaultMode="light">
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  );
}
