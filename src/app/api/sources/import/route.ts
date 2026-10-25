import { withUser, json, readJson, validatedFeedUrl, safeText, ApiError } from "@/lib/data/http";
import { parseOpml } from "@/lib/feeds/opml";
import { parseSafeHttpUrl } from "@/lib/feeds/safe-url";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  return withUser(request, async ({ supabase, user }) => {
    const body = await readJson(request);
    if (typeof body.opml !== "string") throw new ApiError("opml must be text");
    let parsed;
    try {
      parsed = parseOpml(body.opml);
    } catch (cause) {
      throw new ApiError(cause instanceof Error ? cause.message : "Could not parse OPML");
    }
    if (parsed.length > 200) throw new ApiError("OPML import is limited to 200 feeds");

    const unique = new Map<string, { entry: (typeof parsed)[number]; url: string }>();
    for (const entry of parsed) {
      if (!unique.has(entry.url)) unique.set(entry.url, { entry, url: entry.url });
    }
    const candidates: Array<{ url: string; title: string | null; folder: string | null; site_url: string | null; error: string | null }> = [];
    let invalid = 0;
    const entries = [...unique.values()];
    for (let index = 0; index < entries.length; index += 10) {
      const checked = await Promise.all(entries.slice(index, index + 10).map(async ({ entry }) => {
        try {
          const status: { unresolved?: boolean } = {};
          return {
            url: await validatedFeedUrl(entry.url, status),
            title: safeText(entry.title, "title", 500),
            folder: safeText(entry.folder, "folder", 300),
            site_url: entry.site_url ? parseSafeHttpUrl(entry.site_url).toString() : null,
            error: status.unresolved ? "Feed host could not be resolved" : null,
          };
        } catch {
          return null;
        }
      }));
      for (const candidate of checked) {
        if (candidate) candidates.push(candidate);
        else invalid += 1;
      }
    }
    if (candidates.length === 0) return json({ imported: 0, skipped: parsed.length });

    const urls = candidates.map((entry) => entry.url);
    const { data: existing, error: lookupError } = await supabase.from("sources")
      .select("url")
      .in("url", urls);
    if (lookupError) throw new Error(lookupError.message);
    const existingUrls = new Set((existing ?? []).map((row) => row.url));
    const newSources = candidates.filter((entry) => !existingUrls.has(entry.url));
    let imported = 0;
    if (newSources.length > 0) {
      const db = createAdminClient();
      const { data: inserted, error } = await db.from("sources").upsert(
        newSources.map((source) => ({ ...source, user_id: user.id })),
        { onConflict: "user_id,url", ignoreDuplicates: true },
      ).select("url");
      if (error) throw new Error(error.message);
      imported = inserted?.length ?? 0;
    }
    return json({ imported, skipped: parsed.length - imported, invalid });
  });
}
