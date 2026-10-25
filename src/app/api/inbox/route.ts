import { withUser, json } from "@/lib/data/http";

export async function GET(request: Request): Promise<Response> {
  return withUser(request, async ({ supabase, user }) => {
    const { data: sources, error: sourcesError } = await supabase.from("sources")
      .select("id,title,url,folder,site_url,error,last_checked_at,last_success_at")
      .order("created_at", { ascending: true });
    if (sourcesError) throw new Error(sourcesError.message);

    // PostgREST caps individual responses. Keyset paging by stable id ensures
    // every unread row is counted even when a library grows beyond that cap.
    const items: Array<{ id: string; source_id: string; title: string | null; url: string | null; summary: string | null; published_at: string | null; discovered_at: string }> = [];
    let afterId: string | null = null;
    while (true) {
      let query = supabase.from("item_state")
        .select("id,source_id,title,url,summary,published_at,discovered_at")
        .is("seen_at", null)
        .order("id", { ascending: true })
        .limit(500);
      if (afterId) query = query.gt("id", afterId);
      const { data: page, error } = await query;
      if (error) throw new Error(error.message);
      const rows = page ?? [];
      items.push(...rows);
      if (rows.length < 500) break;
      afterId = rows[rows.length - 1].id;
    }

    const unreadCounts = new Map<string, number>();
    for (const item of items ?? []) unreadCounts.set(item.source_id, (unreadCounts.get(item.source_id) ?? 0) + 1);
    items.sort((a, b) => {
      const aTime = Date.parse(a.published_at ?? a.discovered_at);
      const bTime = Date.parse(b.published_at ?? b.discovered_at);
      return bTime - aTime || b.id.localeCompare(a.id);
    });
    return json({
      sources: (sources ?? []).map((source) => ({ ...source, title: source.title || new URL(source.url).hostname, unread_count: unreadCounts.get(source.id) ?? 0 })),
      items: items ?? [],
      user: { email: user.email ?? "" },
    }, 200, { "cache-control": "private, no-store" });
  });
}
