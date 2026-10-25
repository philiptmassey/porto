import { withUser } from "@/lib/data/http";
import { buildOpml } from "@/lib/feeds/opml";

export async function GET(request: Request): Promise<Response> {
  return withUser(request, async ({ supabase }) => {
    const { data, error } = await supabase.from("sources")
      .select("url,title,folder,site_url")
      .order("folder", { ascending: true })
      .order("title", { ascending: true });
    if (error) throw new Error(error.message);
    const xml = buildOpml((data ?? []).map((source) => ({
      ...source,
      title: source.title || source.url,
    })));
    return new Response(xml, {
      headers: {
        "content-type": "text/x-opml; charset=utf-8",
        "content-disposition": 'attachment; filename="porto-feeds.opml"',
        "cache-control": "private, no-store",
      },
    });
  });
}
