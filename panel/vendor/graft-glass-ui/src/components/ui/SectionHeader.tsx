import { IconChevron } from "@/components/icons";
import { cn } from "@/lib/cn";

type SectionHeaderProps = {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
};

export function SectionHeader({
  title,
  description,
  actionLabel,
  onAction,
  className,
}: SectionHeaderProps) {
  return (
    <div className={cn("flex items-end justify-between mb-4 gap-4", className)}>
      <div>
        <h2 className="text-[16px] md:text-[18px] font-[600] tracking-[-0.02em] text-ink">
          {title}
        </h2>
        {description ? <p className="text-[13px] text-ink/45 mt-0.5">{description}</p> : null}
      </div>
      {actionLabel ? (
        <button
          type="button"
          onClick={onAction}
          className="hidden sm:inline-flex items-center gap-1.5 text-[13px] font-[450] text-ink/45 hover:text-ink/85 transition-colors shrink-0"
        >
          {actionLabel}
          <IconChevron size={13} />
        </button>
      ) : null}
    </div>
  );
}
