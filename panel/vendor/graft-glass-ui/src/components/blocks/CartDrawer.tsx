"use client";

import { Button } from "@/components/ui/Button";
import { CartLineItem, type CartItem } from "@/components/ui/CartLineItem";
import { Sheet } from "@/components/ui/Sheet";

type CartDrawerProps = {
  open: boolean;
  onClose: () => void;
  items: CartItem[];
  onRemove?: (id: string) => void;
  onCheckout?: () => void;
};

export function CartDrawer({ open, onClose, items, onRemove, onCheckout }: CartDrawerProps) {
  const total = items.reduce((sum, item) => sum + item.priceSol, 0);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Cart (${items.length})`}
      footer={
        items.length ? (
          <Button variant="primary" className="w-full" onClick={onCheckout}>
            Checkout · {total} SOL
          </Button>
        ) : null
      }
    >
      {items.length === 0 ? (
        <p className="text-ink/45 text-[14px] text-center mt-20">Your cart is empty.</p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <CartLineItem key={item.id} item={item} onRemove={onRemove} />
          ))}
        </div>
      )}
    </Sheet>
  );
}
