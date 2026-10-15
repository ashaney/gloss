"use client";

import { barBtn } from "@/components/ui/Popover";

/** Sync is always on for the local reader; agent connections live in the library's Add panel. */
export function Account() {
  return (
    <span className={`${barBtn} !px-3 whitespace-nowrap`} data-tip="Highlights and notes sync to the local library">
      Synced
    </span>
  );
}
