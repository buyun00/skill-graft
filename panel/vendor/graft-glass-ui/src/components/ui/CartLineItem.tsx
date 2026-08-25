"use client";

import { IconClose } from "@/components/icons";
import { Glass } from "@/components/primitives/Glass";
import { Price } from "@/components/ui/Price";

export type CartItem = {
  id: string;
  title: string;
  priceSol: number;
};

export function CartLineItem({
  item,
  onRemove,
}: {
  item: CartItem;
  onRemove?: (id: string) => void;
}) {
  return (
    <Glass radius={12} className="p-3 flex items-center gap-3 rounded-xl">
      <div className="flex-1 min-w-0">
        <div className="text-ink text-[14px] font-[500] truncate">{item.title}</div>
        <Price amount={item.priceSol} size="sm" className="mt-0.5" />
      </div>
      <button
        type="button"
        aria-label={`Remove ${item.title}`}
        onClick={() => onRemove?.(item.id)}
        className="w-7 h-7 rounded-lg text-ink/40 hover:text-ink hover:bg-ink/5 flex items-center justify-center"
      >
        <IconClose size={12} />
      </button>
    </Glass>
  );
}
