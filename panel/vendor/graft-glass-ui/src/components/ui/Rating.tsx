import { cn } from "@/lib/cn";

type RatingProps = {
  value?: number | null;
  reviewCount?: number | null;
  salesCount?: number | null;
  className?: string;
};

export function Rating({ value, reviewCount, salesCount, className }: RatingProps) {
  return (
    <div className={cn("flex items-center gap-1.5 text-[12px]", className)}>
      {value != null ? (
        <>
          <span className="text-ink/85">★</span>
          <span className="text-ink/70 font-[500]">{value.toFixed(1)}</span>
          {reviewCount ? <span className="text-ink/30">({reviewCount})</span> : null}
        </>
      ) : (
        <span className="text-ink/30">No ratings yet</span>
      )}
      {salesCount ? <span className="text-ink/20">· {salesCount} sold</span> : null}
    </div>
  );
}
