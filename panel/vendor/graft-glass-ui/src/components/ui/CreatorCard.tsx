import { IconChevron, IconPlus } from "@/components/icons";
import { SpinningBorder } from "@/components/primitives/SpinningBorder";
import { cn } from "@/lib/cn";

type CreatorCardProps = {
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  href?: string;
  className?: string;
};

export function CreatorCard({
  eyebrow = "Creator",
  title = "Publish your skill",
  subtitle = "Earn in SOL",
  href = "#",
  className,
}: CreatorCardProps) {
  return (
    <a
      href={href}
      className={cn(
        "group relative block rounded-[14px] transition-transform duration-300 ease-out hover:-translate-y-[1px]",
        className,
      )}
    >
      <SpinningBorder radius={14} duration={9} tone="ink">
        <div className="relative flex items-center gap-3 px-3.5 py-3">
          <div className="min-w-0 flex-1">
            <div
              style={{
                fontSize: 9.5,
                fontWeight: 500,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: "rgba(var(--gg-ink-rgb),0.3)",
                marginBottom: 3,
              }}
            >
              {eyebrow}
            </div>
            <div
              className="transition-colors duration-200"
              style={{
                fontSize: 14,
                fontWeight: 500,
                letterSpacing: "-0.015em",
                color: "rgba(var(--gg-ink-rgb),0.85)",
                lineHeight: 1.2,
              }}
            >
              {title}
            </div>
            <div
              className="mt-[3px] flex items-center gap-1.5"
              style={{
                fontSize: 11.5,
                fontWeight: 300,
                color: "rgba(var(--gg-ink-rgb),0.4)",
                letterSpacing: "-0.005em",
              }}
            >
              <span>{subtitle}</span>
              <IconChevron
                size={9}
                className="transition-all duration-300 ease-out text-ink/30 group-hover:text-ink/70 group-hover:translate-x-0.5"
              />
            </div>
          </div>
          <IconPlus
            size={15}
            className="relative flex-shrink-0 transition-all duration-300 ease-out text-ink/45 group-hover:text-ink/85 group-hover:rotate-90"
          />
        </div>
      </SpinningBorder>
    </a>
  );
}
