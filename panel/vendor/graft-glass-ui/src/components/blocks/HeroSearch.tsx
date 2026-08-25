"use client";

import { useState, type FormEvent } from "react";
import { IconSearch } from "@/components/icons";
import { SpinningBorder } from "@/components/primitives/SpinningBorder";

type HeroSearchProps = {
  title?: string;
  subtitle?: string;
  placeholder?: string;
  defaultValue?: string;
  onSearch?: (query: string) => void;
};

export function HeroSearch({
  title = "Find the perfect skills for your AI agent",
  subtitle = "Extend your agent's capabilities with trusted, production-ready skills. Install in seconds, pay once in SOL.",
  placeholder = "Search skills, categories, or use cases…",
  defaultValue = "",
  onSearch,
}: HeroSearchProps) {
  const [value, setValue] = useState(defaultValue);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    onSearch?.(value);
  };

  return (
    <div className="relative mb-9 md:mb-10">
      <h1 className="text-[32px] md:text-[44px] font-[600] tracking-[-0.03em] leading-[1.06] text-ink mb-3">
        {title}
      </h1>
      <p className="text-[15px] md:text-[16px] font-[400] text-ink/55 leading-[1.6] mb-5 max-w-[520px]">
        {subtitle}
      </p>
      <form className="relative max-w-[720px]" onSubmit={submit}>
        <SpinningBorder tone="accent" duration={6} radius={18}>
          <div className="relative rounded-[18px] overflow-hidden bg-ink/[0.025]">
            <div className="flex flex-col sm:flex-row sm:items-center sm:h-[58px]">
              <div className="flex items-center gap-3 flex-1 min-w-0 px-4 py-4 sm:py-0 sm:pl-5">
                <IconSearch className="w-[19px] h-[19px] text-ink/40 flex-shrink-0" size={19} />
                <input
                  type="text"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={placeholder}
                  className="flex-1 min-w-0 bg-transparent text-[16px] font-[400] tracking-[-0.01em] text-ink placeholder:text-ink/25 focus:outline-none"
                />
              </div>
              <div className="px-2.5 pb-2.5 sm:p-0 sm:pr-2.5">
                <button
                  type="submit"
                  className="w-full sm:w-auto flex items-center justify-center gap-2 px-4 md:px-6 h-12 sm:h-10 rounded-[14px] sm:rounded-[12px] text-[14px] sm:text-[13px] font-[600] active:scale-[0.98] transition-all flex-shrink-0 hover:brightness-110"
                  style={{
                    background: "linear-gradient(180deg, var(--gg-accent-hi), var(--gg-accent-lo))",
                    color: "var(--gg-on-accent)",
                  }}
                >
                  Search
                </button>
              </div>
            </div>
          </div>
        </SpinningBorder>
      </form>
    </div>
  );
}
