import { IconTile } from "@/components/ui/IconTile";
import { rgbOf } from "@/lib/categories";

export type RankedItem = {
  id: string;
  title: string;
  category?: string;
  href?: string;
};

type RankedRowProps = {
  item: RankedItem;
  rank?: number;
};

export function RankedRow({ item, rank }: RankedRowProps) {
  const rgb = rgbOf(item.category);
  return (
    <a
      href={item.href ?? "#"}
      className="group flex items-center gap-2.5 rounded-xl px-2 py-2 -mx-2 hover:bg-ink/[0.04] transition-colors"
    >
      {rank != null ? (
        <span className="w-3.5 text-[12px] font-[600] text-ink/35 text-center shrink-0">
          {rank}
        </span>
      ) : null}
      <IconTile rgb={rgb} size={32}>
        {item.title[0]?.toUpperCase()}
      </IconTile>
      <span className="text-[13px] font-[500] text-ink/85 truncate group-hover:text-ink transition-colors min-w-0 flex-1">
        {item.title}
      </span>
    </a>
  );
}
