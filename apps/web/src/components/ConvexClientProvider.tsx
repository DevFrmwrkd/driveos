"use client";

import React, { ReactNode, createContext, useContext } from "react";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL || "https://determined-anaconda-827.convex.cloud";
const convexClient = new ConvexReactClient(convexUrl);

const ConvexContext = createContext<{ isLive: boolean; client: ConvexReactClient }>({
  isLive: true,
  client: convexClient,
});

export function useConvexStatus() {
  return useContext(ConvexContext);
}

export default function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexContext.Provider value={{ isLive: true, client: convexClient }}>
      <ConvexAuthNextjsProvider client={convexClient}>{children}</ConvexAuthNextjsProvider>
    </ConvexContext.Provider>
  );
}
