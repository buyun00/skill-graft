"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

export type ToastType = "success" | "error" | "info" | "warning";

export type ToastData = {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
};

const ICONS: Record<ToastType, { borderColor: string; icon: ReactNode }> = {
  success: {
    borderColor: "#5cd882",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M6.5 10.5L9 13l4.5-6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  error: {
    borderColor: "#ef4444",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7 7l6 6M13 7l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  info: {
    borderColor: "#6da6f7",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 9v5M10 6.5v.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  warning: {
    borderColor: "#f0b030",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path d="M10 2L1 18h18L10 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M10 8v4M10 14.5v.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
};

type ToastContextValue = {
  toast: (input: Omit<ToastData, "id"> & { id?: string }) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

function ToastItem({ data, onDismiss }: { data: ToastData; onDismiss: (id: string) => void }) {
  const [leaving, setLeaving] = useState(false);
  const [progress, setProgress] = useState(100);
  const started = useRef(Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      const next = Math.max(0, 100 - ((Date.now() - started.current) / 5000) * 100);
      setProgress(next);
      if (next <= 0) {
        clearInterval(timer);
        setLeaving(true);
        setTimeout(() => onDismiss(data.id), 300);
      }
    }, 50);
    return () => clearInterval(timer);
  }, [data.id, onDismiss]);

  const tone = ICONS[data.type];

  return (
    <div
      role={data.type === "error" ? "alert" : undefined}
      className={cn(
        "relative overflow-hidden rounded-xl w-[380px] max-w-[calc(100vw-32px)]",
        "transition-all duration-300 ease-out",
        leaving ? "opacity-0 translate-x-[100%]" : "opacity-100 translate-x-0",
      )}
      style={{
        background: "rgba(var(--gg-glass-rgb), var(--gg-glass-alpha))",
        backdropFilter: "blur(12px)",
        border: "1px solid rgba(var(--gg-line-rgb), var(--gg-line-alpha))",
        borderLeft: `4px solid ${tone.borderColor}`,
        boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
      }}
    >
      <div className="flex items-start gap-3 px-4 py-3.5">
        <span className="mt-0.5" style={{ color: tone.borderColor }}>
          {tone.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-[550] text-ink">{data.title}</div>
          {data.description ? (
            <div className="text-[12px] text-ink/45 mt-0.5 leading-relaxed">{data.description}</div>
          ) : null}
        </div>
      </div>
      <div className="h-[2px] bg-ink/[0.04]">
        <div
          className="h-full"
          style={{ width: `${progress}%`, background: tone.borderColor, opacity: 0.7 }}
        />
      </div>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastData[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((input: Omit<ToastData, "id"> & { id?: string }) => {
    const id = input.id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setItems((prev) => [...prev, { ...input, id }]);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed top-6 right-6 z-[70] flex flex-col gap-3 pointer-events-none">
        <div className="pointer-events-auto flex flex-col gap-3">
          {items.map((item) => (
            <ToastItem key={item.id} data={item} onDismiss={dismiss} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}
