"use client";

import { EmptyState } from "graft-glass-ui/src/components";
import { IconStore } from "graft-glass-ui/src/components/icons";

export function StoreView() {
  return (
    <section className="glass rounded-[22px]">
      <EmptyState
        icon={<IconStore size={22} />}
        title="商店尚未接通"
        description="本机 Skill Hub 不是 GRAFT 市场。商店尚未接通，这里不会放假商品。"
      />
    </section>
  );
}
