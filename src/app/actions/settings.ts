"use server";

import { refresh } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { setSetting } from "@/lib/db";
import { attempt, type Result } from "./_shared";

const ALLOWED_KEYS = new Set([
  "bar_name", "app_subtitle", "business_day_cutoff_hour", "business_tz",
]);

export async function updateSetting(key: string, value: string): Promise<Result> {
  return attempt(async () => {
    await requireOwner();
    if (!ALLOWED_KEYS.has(key)) throw new Error(`Unknown setting: ${key}`);
    const v = value.trim();
    if (!v) throw new Error("Value cannot be empty");
    if (key === "business_day_cutoff_hour") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 23) throw new Error("Cutoff hour must be 0-23");
    }
    await setSetting(key, v);
    refresh();
  });
}
