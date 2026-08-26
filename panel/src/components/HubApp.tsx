"use client";

import { ProductApp } from "./ProductApp";

// Keep the existing Next entry point while routing the panel to the
// user-facing product shell. The old command/status component tree is no
// longer mounted in production.
export function HubApp() {
  return <ProductApp />;
}
