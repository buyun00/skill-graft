"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { IconSearch } from "@/components/icons";
import { Overlay } from "@/components/ui/Overlay";
import { Kbd } from "@/components/ui/Kbd";
import { Price } from "@/components/ui/Price";

export type CommandQuickLink = { label: string; href: string };
export type CommandResult = {
  id: string;
  title: string;
  category?: string;
  author?: string;
  priceSol?: number;
  href?: string;
};

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quickLinks?: CommandQuickLink[];
  results?: CommandResult[];
  loading?: boolean;
  onQueryChange?: (query: string) => void;
  onNavigate?: (href: string) => void;
};

const DEFAULT_LINKS: CommandQuickLink[] = [
  { label: "Explore all skills", href: "#explore" },
  { label: "Publish a skill", href: "#publish" },
  { label: "Your dashboard", href: "#dashboard" },
  { label: "Your purchases", href: "#purchases" },
  { label: "Settings", href: "#settings" },
];

export function CommandPalette({
  open,
  onOpenChange,
  quickLinks = DEFAULT_LINKS,
  results = [],
  loading,
  onQueryChange,
  onNavigate,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    onOpenChange(false);
    setQuery("");
    setActiveIndex(0);
  }, [onOpenChange]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      } else if (event.key === "Escape" && open) {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange, close]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    onQueryChange?.(query);
  }, [query, onQueryChange]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, results.length, quickLinks.length]);

  if (!open) return null;

  const go = (href: string) => {
    onNavigate?.(href);
    close();
  };

  const selectable = query
    ? results.map((item) => item.href ?? `#skill-${item.id}`)
    : quickLinks.map((link) => link.href);

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(selectable.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const href = selectable[activeIndex] ?? selectable[0];
      if (href) go(href);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4">
      <Overlay onClick={close} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search skills"
        className="relative w-full max-w-[560px] bg-panel border border-ink/10 rounded-2xl overflow-hidden shadow-2xl"
        style={{ animation: "modalIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)" }}
      >
        <div className="flex items-center gap-3 px-4 h-14 border-b border-ink/5">
          <IconSearch className="w-4 h-4 text-ink/40" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="搜索技能、工作区、更新…"
            aria-label="搜索技能、工作区、更新"
            className="flex-1 bg-transparent text-ink text-[15px] outline-none placeholder:text-ink/25"
          />
          <Kbd>ESC</Kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2 preview-scroll">
          {loading ? <div className="p-4 text-ink/40 text-[13px]">Searching…</div> : null}
          {!loading && query && results.length === 0 ? (
            <div className="p-4 text-ink/40 text-[13px]">No results.</div>
          ) : null}
          {!query ? (
            <div className="p-2">
              <div className="text-[10px] uppercase tracking-wider text-ink/30 px-3 pb-1.5">
                Quick
              </div>
              {quickLinks.map((link, index) => (
                <button
                  key={link.href}
                  type="button"
                  onClick={() => go(link.href)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-ink/75 text-[14px] ${
                    index === activeIndex ? "bg-ink/5" : "hover:bg-ink/5"
                  }`}
                >
                  {link.label}
                </button>
              ))}
            </div>
          ) : null}
          {results.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => go(item.href ?? `#skill-${item.id}`)}
              className={`w-full text-left px-3 py-3 rounded-lg flex items-center gap-3 ${
                query && index === activeIndex ? "bg-ink/5" : "hover:bg-ink/5"
              }`}
            >
              <div className="w-8 h-8 rounded-lg bg-ink/5 border border-ink/10 flex items-center justify-center text-ink/70 text-[14px] font-[600] flex-shrink-0">
                {item.title[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-ink text-[14px] truncate">{item.title}</div>
                <div className="text-ink/40 text-[11px] truncate capitalize">
                  {item.category}
                  {item.author ? ` · ${item.author}` : ""}
                </div>
              </div>
              {item.priceSol != null ? <Price amount={item.priceSol} size="sm" /> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
