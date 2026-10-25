import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { refreshDueSources } from "@/lib/data/refresh";
import { json } from "@/lib/data/http";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    ?? request.headers.get("x-cron-secret");
  if (!supplied) return false;
  const suppliedBytes = Buffer.from(supplied);
  const secretBytes = Buffer.from(secret);
  if (suppliedBytes.length !== secretBytes.length) return false;
  return timingSafeEqual(suppliedBytes, secretBytes);
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
  try {
    const db = createAdminClient();
    const { count, error } = await db.from("sources").select("id", { count: "exact", head: true });
    if (error) throw new Error(error.message);
    const total = count ?? 0;
    let refreshed = 0;
    let failed = 0;
    let processed = 0;
    const claimedIds: string[] = [];
    while (processed < total) {
      const batch = await refreshDueSources({ limit: 200, excludeIds: claimedIds });
      refreshed += batch.refreshed;
      failed += batch.failed;
      const claimedThisBatch = batch.claimedIds.length;
      processed += claimedThisBatch;
      claimedIds.push(...batch.claimedIds);
      if (claimedThisBatch < 200) break;
    }
    return json({ refreshed, failed, skipped: Math.max(0, total - processed), total });
  } catch (cause) {
    console.error("Scheduled feed refresh failed", cause);
    return json({ error: "Scheduled refresh failed" }, 500);
  }
}
