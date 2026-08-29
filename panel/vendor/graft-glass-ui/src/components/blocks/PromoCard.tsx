import { IconChevron } from "@/components/icons";
import { Hairline } from "@/components/primitives/Hairline";

type PromoCardProps = {
  title?: string;
  description?: string;
  actionLabel?: string;
  href?: string;
};

export function PromoCard({
  title = "Earn as a creator",
  description = "Publish your skills, keep 90%, and earn in SOL from every sale.",
  actionLabel = "Publish your skill",
  href = "#",
}: PromoCardProps) {
  return (
    <div className="relative rounded-2xl overflow-hidden border border-accent/20 p-5">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(circle 200px at 85% 18%, rgba(var(--gg-accent-rgb),0.26), transparent 70%), radial-gradient(circle 200px at 10% 100%, rgba(var(--gg-motion-rgb),0.16), transparent 70%)",
        }}
      />
      <Hairline inset="8%" color="rgba(var(--gg-ink-rgb),0.18)" />
      <div className="relative">
        <h3 className="text-[16px] font-[600] tracking-[-0.02em] text-ink mb-1">{title}</h3>
        <p className="text-[12.5px] text-ink/60 leading-[1.5] mb-4">{description}</p>
        <a
          href={href}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-ink text-page text-[13px] font-[600] hover:opacity-[0.88] transition-opacity"
        >
          {actionLabel}
          <IconChevron size={13} />
        </a>
      </div>
    </div>
  );
}
