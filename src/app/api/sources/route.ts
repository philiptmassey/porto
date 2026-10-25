import { withUser, json, readJson, safeText, validatedFeedUrl, ApiError } from "@/lib/data/http";
import { refreshDueSources } from "@/lib/data/refresh";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  return withUser(request, async ({ supabase, user }) => {
    const body = await readJson(request);
    const url = await validatedFeedUrl(body.url);
    const title = safeText(body.title, "title", 500) ?? new URL(url).hostname;
    const folder = safeText(body.folder, "folder", 300);
    const db = createAdminClient();
    const { data, error } = await db.from("sources")
      .insert({ user_id: user.id, url, title, folder })
      .select("id,title,url,folder,site_url,error,last_checked_at,last_success_at")
      .single();
    if (error?.code === "23505") throw new ApiError("This feed is already in your library", 409);
    if (error || !data) throw new Error(error?.message ?? "Could not add feed");

    // A new source gets one immediate refresh. The source-specific lease keeps
    // concurrent add/refresh requests from issuing duplicate network fetches.
    await refreshDueSources({ userId: user.id, sourceId: data.id, force: true, limit: 1 });
    const { data: refreshed, error: refreshError } = await supabase.from("sources")
      .select("id,title,url,folder,site_url,error,last_checked_at,last_success_at")
      .eq("id", data.id)
      .single();
    if (refreshError) throw new Error(refreshError.message);
    return json({ source: refreshed }, 201);
  });
}
