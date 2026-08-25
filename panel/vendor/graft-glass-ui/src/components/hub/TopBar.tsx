"use client";

import { IconBell, IconChevron, IconMoon, IconPlus, IconSearch, IconSun } from "@/components/icons";
import { CountBadge } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/IconButton";
import { Kbd } from "@/components/ui/Kbd";
import { useTheme } from "@/theme/ThemeProvider";

export function TopBar({
  placeholder = "搜索技能、工作区、更新…",
  notifyCount = 0,
  onSearch,
  onCreate,
  onNotify,
}: {
  placeholder?: string;
  notifyCount?: number;
  onSearch?: () => void;
  onCreate?: () => void;
  onNotify?: () => void;
}) {
  const { mode, toggleMode } = useTheme();
  return (
    <div className="flex items-center gap-3 mb-6">
      <button
        type="button"
        onClick={onSearch}
        className="flex-1 h-11 rounded-2xl glass px-4 flex items-center gap-2.5 text-left hover:-translate-y-[1px] transition-transform duration-200"
      >
        <IconSearch size={15} className="text-ink/35" />
        <span className="flex-1 text-[13.5px] text-ink/40">{placeholder}</span>
        <Kbd>⌘K</Kbd>
      </button>
      <button
        type="button"
        onClick={onCreate}
        className="h-11 px-3.5 rounded-2xl glass inline-flex items-center gap-1.5 text-[13px] font-[550] text-ink hover:-translate-y-[1px] transition-transform"
      >
        <IconPlus size={14} />
        新建
        <IconChevron size={12} className="text-ink/40" />
      </button>
      <button
        type="button"
        onClick={onNotify}
        className="relative h-11 w-11 rounded-2xl glass inline-flex items-center justify-center text-ink/60 hover:text-ink"
      >
        <IconBell size={16} />
        {notifyCount > 0 ? (
          <CountBadge tone="solid" className="absolute top-2 right-2 min-w-[16px] h-4 text-[9px]">
            {notifyCount}
          </CountBadge>
        ) : null}
      </button>
      <IconButton
        shape="round"
        className="h-11 w-11 rounded-2xl glass"
        aria-label="Toggle theme"
        onClick={toggleMode}
      >
        {mode === "dark" ? <IconSun size={16} /> : <IconMoon size={16} />}
      </IconButton>
    </div>
  );
}
