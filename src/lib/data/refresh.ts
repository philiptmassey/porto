import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchFeed } from "@/lib/feeds/fetch";

type ClaimedSource = {
  id: string;
  user_id: string;
  url: string;
  etag: string | null;
  last_modified: string | null;
  refresh_token: string;
};

export type RefreshCounts = { refreshed: number; failed: number; skipped: number; claimedIds: string[]; total: number };

/** Claim and refresh due feeds. The database lease makes overlapping page loads harmless. */
export async function refreshDueSources(options: {
  userId?: string;
  sourceId?: string;
  excludeIds?: string[];
  force?: boolean;
  limit?: number;
} = {}): Promise<RefreshCounts> {
  const db = createAdminClient();
  let total = 0;
  let totalQuery = db.from("sources").select("id", { count: "exact", head: true });
  if (options.userId) totalQuery = totalQuery.eq("user_id", options.userId);
  const { count, error: countError } = await totalQuery;
  if (countError) throw new Error(`Could not count feeds: ${countError.message}`);
  total = count ?? 0;
  const { data, error } = await db.rpc("claim_due_sources", {
    p_user_id: options.userId ?? null,
    p_force: options.force ?? false,
    p_limit: options.limit ?? 200,
    p_source_id: options.sourceId ?? null,
    p_exclude_ids: options.excludeIds ?? [],
  });
  if (error) throw new Error(`Could not claim feeds for refresh: ${error.message}`);

  const claimed = (data ?? []) as ClaimedSource[];
  const results: Array<"refreshed" | "failed"> = [];
  const refreshOne = async (source: ClaimedSource): Promise<"refreshed" | "failed"> => {
    try {
      const feed = await fetchFeed(source.url, {
        etag: source.etag,
        lastModified: source.last_modified,
      });
      const items = [...new Map(feed.items.map((item) => [item.item_key, item])).values()];
      const { data: accepted, error: finishError } = await db.rpc("finish_source_refresh", {
        p_user_id: source.user_id,
        p_source_id: source.id,
        p_refresh_token: source.refresh_token,
        p_not_modified: feed.notModified,
        p_title: feed.title ?? null,
        p_site_url: feed.siteUrl ?? null,
        p_etag: feed.etag,
        p_last_modified: feed.lastModified,
        p_error: null,
        p_items: items,
      });
      if (finishError) throw new Error(finishError.message);
      if (!accepted) throw new Error("Refresh lease expired before completion");
      return "refreshed" as const;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Feed refresh failed";
      const { error: finishError } = await db.rpc("finish_source_refresh", {
        p_user_id: source.user_id,
        p_source_id: source.id,
        p_refresh_token: source.refresh_token,
        p_not_modified: false,
        p_error: message.slice(0, 2000),
        p_items: [],
      });
      if (finishError) console.error("Could not record feed refresh failure", finishError);
      return "failed" as const;
    }
  };

  // Keep outbound requests bounded when a library contains many feeds.
  for (let index = 0; index < claimed.length; index += 10) {
    results.push(...await Promise.all(claimed.slice(index, index + 10).map(refreshOne)));
  }

  return {
    refreshed: results.filter((result) => result === "refreshed").length,
    failed: results.filter((result) => result === "failed").length,
    skipped: Math.max(0, total - claimed.length),
    claimedIds: claimed.map((source) => source.id),
    total,
  };
}

