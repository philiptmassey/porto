import { withUser, json, readJson, validateIds } from "@/lib/data/http";

export async function POST(request: Request): Promise<Response> {
  return withUser(request, async ({ supabase }) => {
    const body = await readJson(request);
    const ids = validateIds(body.ids);
    if (ids.length === 0) return json({ updated: 0 });
    const { data, error } = await supabase.rpc("undo_items_seen", { p_ids: ids });
    if (error) throw new Error(error.message);
    return json({ updated: Number(data ?? 0) });
  });
}
