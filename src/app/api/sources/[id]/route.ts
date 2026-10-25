import { withUser, json, ApiError } from "@/lib/data/http";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  return withUser(request, async ({ supabase }) => {
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError("Invalid source id");
    const { data, error } = await supabase.from("sources").delete().eq("id", id).select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new ApiError("Feed not found", 404);
    return json({ deleted: true });
  });
}
