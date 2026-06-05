"use client";

import React, { ReactNode, createContext, useContext } from "react";
import { ConvexProvider, ConvexReactClient } from "convex/react";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL || "http://localhost:3001";
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
      <ConvexProvider client={convexClient}>{children}</ConvexProvider>
    </ConvexContext.Provider>
  );
}
