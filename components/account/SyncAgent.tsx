"use client";

import { useEffect } from "react";
import { LOCAL_USER_ID } from "@/lib/user";
import { useStore } from "@/lib/store";
import { startSync } from "@/lib/sync";

/** Runs sync for the local reader. Renders nothing. */
export function SyncAgent() {
  useEffect(() => {
    useStore.getState().hydrate();
    const s = startSync(LOCAL_USER_ID);
    return () => s.stop();
  }, []);
  return null;
}
