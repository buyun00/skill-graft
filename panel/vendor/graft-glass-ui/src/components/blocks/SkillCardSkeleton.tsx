import { Hairline } from "@/components/primitives/Hairline";
import { Skeleton } from "@/components/ui/Skeleton";

export function SkillCardSkeleton({ delay = 0 }: { delay?: number }) {
  return (
    <div
      className="relative overflow-hidden"
      style={{ borderRadius: 20, minHeight: 220 }}
    >
      <div
        className="absolute inset-0"
        style={{
          background: "rgba(var(--gg-ink-rgb),0.03)",
          border: "1px solid rgba(var(--gg-ink-rgb),0.07)",
          borderRadius: 20,
        }}
      />
      <Hairline />
      <div className="relative flex flex-col h-full p-5 min-h-[220px]">
        <div className="flex items-start justify-between">
          <Skeleton shimmer delay={delay} className="w-12 h-12 rounded-[13px]" />
          <Skeleton shimmer delay={delay + 0.1} className="w-16 h-5 rounded-lg" />
        </div>
        <div className="space-y-3 mt-6">
          <Skeleton shimmer delay={delay} className="w-3/4 h-5" />
          <Skeleton shimmer delay={delay + 0.08} className="w-full h-4" />
          <Skeleton shimmer delay={delay + 0.16} className="w-2/3 h-4" />
        </div>
        <div className="flex items-center justify-between mt-auto pt-6">
          <Skeleton shimmer delay={delay} className="w-16 h-5" />
          <Skeleton shimmer delay={delay} className="w-6 h-6 rounded-full" />
        </div>
      </div>
    </div>
  );
}
