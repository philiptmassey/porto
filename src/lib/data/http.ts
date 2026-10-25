import { requireUser } from "@/lib/auth";
import { isIP } from "node:net";
import { isPublicAddress, parseSafeHttpUrl, resolvePublicAddress } from "@/lib/feeds/safe-url";

export class ApiError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

export async function withUser(
  request: Request,
  handler: (context: Awaited<ReturnType<typeof requireUser>>) => Promise<Response>,
): Promise<Response> {
  try {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method.toUpperCase())) {
      const origin = request.headers.get("origin");
      const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
      if ((origin && origin !== new URL(request.url).origin) || fetchSite === "cross-site") {
        return json({ error: "Cross-origin request rejected" }, 403);
      }
    }
    return await handler(await requireUser());
  } catch (cause) {
    if (cause instanceof ApiError) return json({ error: cause.message }, cause.status);
    if (cause instanceof Error && /unauthorized|not authenticated/i.test(cause.message)) {
      return json({ error: "Authentication required" }, 401);
    }
    console.error("API request failed", request.method, new URL(request.url).pathname, cause);
    return json({ error: "Request failed" }, 500);
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > 4 * 1024 * 1024) throw new Error();
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 4 * 1024 * 1024) throw new Error();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError("Request body must be a JSON object");
  }
}

export async function validatedFeedUrl(input: unknown, status?: { unresolved?: boolean }): Promise<string> {
  if (typeof input !== "string" || input.length > 8_192) throw new ApiError("Feed URL is required");
  let url: URL;
  try {
    url = parseSafeHttpUrl(input.trim());
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const family = isIP(hostname);
    if (family && !isPublicAddress(hostname)) throw new Error("Feed host resolves to a non-public address");
    if (!family && (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local"))) {
      throw new Error("Feed host must be public");
    }
    if (!family) {
      try {
        await resolvePublicAddress(hostname);
      } catch (cause) {
        // A temporary DNS failure should not discard an otherwise safe URL.
        // Import callers may persist this status until the next refresh.
        if (!(cause instanceof Error) || !cause.message.includes("could not be resolved")) throw cause;
        if (status) status.unresolved = true;
      }
    }
  } catch (cause) {
    throw new ApiError(cause instanceof Error ? cause.message : "Feed URL is invalid");
  }
  url.hash = "";
  return url.toString();
}

export function safeText(input: unknown, name: string, maxLength: number): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string") throw new ApiError(`${name} must be text`);
  const value = input.trim();
  if (value.length > maxLength) throw new ApiError(`${name} is too long`);
  return value || null;
}

export function validateIds(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 5_000) throw new ApiError("ids must be an array with at most 5000 entries");
  const ids = [...new Set(input.filter((id): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))];
  if (ids.length !== input.length) throw new ApiError("Each id must be a valid UUID");
  return ids;
}

