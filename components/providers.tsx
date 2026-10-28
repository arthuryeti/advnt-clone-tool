"use client";

import NiceModal from "@ebay/nice-modal-react";
import type * as React from "react";
import { Toaster } from "@/components/ui/sonner";
import { TRPCProvider } from "@/trpc/client";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TRPCProvider>
      <NiceModal.Provider>
        {children}
        <Toaster />
      </NiceModal.Provider>
    </TRPCProvider>
  );
}
