import { withUser, json } from "@/lib/data/http";
import { refreshDueSources } from "@/lib/data/refresh";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  return withUser(request, async ({ user }) => {
    const force = new URL(request.url).searchParams.get("force") === "true";
    let refreshed = 0;
    let failed = 0;
    let total = 0;
    const claimedIds: string[] = [];
    while (true) {
      const batch = await refreshDueSources({ userId: user.id, force, limit: 200, excludeIds: claimedIds });
      refreshed += batch.refreshed;
      failed += batch.failed;
      total = batch.total;
      claimedIds.push(...batch.claimedIds);
      if (batch.claimedIds.length < 200) return json({ refreshed, failed, skipped: Math.max(0, total - claimedIds.length) });
    }
  });
}
