import "server-only";

import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import Parser from "rss-parser";
import { parseSafeHttpUrl, resolvePublicAddress } from "./safe-url";

export type FeedValidators = { etag?: string | null; lastModified?: string | null };
export type FeedItem = {
  item_key: string;
  title: string;
  url: string;
  summary: string | null;
  published_at: string | null;
};
export type FetchedFeed = {
  notModified: boolean;
  title?: string;
  siteUrl?: string | null;
  etag: string | null;
  lastModified: string | null;
  items: FeedItem[];
};
export type ParsedFeed = Pick<FetchedFeed, "title" | "siteUrl" | "items">;

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_ITEMS = 2_000;
const MAX_SUMMARY_LENGTH = 2_000;
const parser = new Parser({ timeout: REQUEST_TIMEOUT_MS });
const shapeParser = new XMLParser({
  ignoreAttributes: false,
  processEntities: false,
  maxNestedTags: 100,
});

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text = String(value)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  text = text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);?/gi, (entity, code: string) => {
    const key = code.toLowerCase();
    if (key === "amp") return "&";
    if (key === "lt") return "<";
    if (key === "gt") return ">";
    if (key === "quot") return '"';
    if (key === "apos") return "'";
    if (key === "nbsp") return " ";
    const number = key.startsWith("#x") ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
    try { return Number.isFinite(number) && number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : " "; }
    catch { return " "; }
  });
  text = text.replace(/<[^>]*>/g, " ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, MAX_SUMMARY_LENGTH) : null;
}

function safeItemUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8_192) return null;
  try {
    const url = parseSafeHttpUrl(value.trim());
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function canonicalKeyUrl(value: string): string {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid|ref|source)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

function toPublishedAt(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value.toISOString();
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

/** Parses feed XML without network access; also used by feed ingestion after the safe fetch. */
export async function parseFeedXml(xml: string): Promise<ParsedFeed> {
  if (Buffer.byteLength(xml, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Feed response exceeds the size limit");
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error("Feed response is not valid XML");
  let document: unknown;
  try {
    document = shapeParser.parse(xml);
  } catch {
    throw new Error("Feed response has an invalid XML structure");
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("Feed response is not an RSS, RDF, or Atom feed");
  }
  const roots = Object.keys(document).filter((key) => !key.startsWith("?"));
  const [rootName, ...extraRoots] = roots;
  const rootLocalName = rootName?.split(":").at(-1)?.toLowerCase();
  const root = (document as Record<string, unknown>)[rootName];
  const rootObject = root && typeof root === "object" && !Array.isArray(root)
    ? root as Record<string, unknown>
    : null;
  const hasChannel = (value: Record<string, unknown> | null) => Boolean(value && Object.hasOwn(value, "channel"));
  const isFeedShape = extraRoots.length === 0 && (
    (rootLocalName === "rss" && hasChannel(rootObject)) ||
    (rootLocalName === "rdf" && hasChannel(rootObject)) ||
    rootLocalName === "feed"
  );
  if (!isFeedShape) throw new Error("Feed response is not an RSS, RDF, or Atom feed");

  const feed = await parser.parseString(xml);
  const feedUrl = safeItemUrl(feed.link) ?? safeItemUrl(feed.feedUrl) ?? null;
  const items: FeedItem[] = [];
  const rawItems = feed.items ?? [];
  if (rawItems.length > MAX_ITEMS) throw new Error(`Feed contains too many items (limit ${MAX_ITEMS})`);
  const seenItemKeys = new Set<string>();
  for (const raw of rawItems) {
    const item = raw as Record<string, unknown>;
    const itemUrl = safeItemUrl(item.link ?? item.url);
    if (!itemUrl) continue;
    const title = cleanText(item.title) ?? itemUrl;
    const guidValue = item.guid ?? item.id;
    const guid = typeof guidValue === "string" && guidValue.trim() ? guidValue.trim() : null;
    const identity = guid ? `guid:${guid}` : `url:${canonicalKeyUrl(itemUrl)}`;
    const itemKey = stableHash(identity);
    if (seenItemKeys.has(itemKey)) continue;
    seenItemKeys.add(itemKey);
    const summary = cleanText(item.content ?? item["content:encoded"] ?? item.summary ?? item.contentSnippet);
    items.push({
      item_key: itemKey,
      title,
      url: itemUrl,
      summary,
      published_at: toPublishedAt(item.isoDate ?? item.pubDate ?? item.published ?? item.updated),
    });
  }
  const title = cleanText(feed.title);
  if (!title && items.length === 0) throw new Error("Empty feed is missing its title");
  return { title: title ?? "Untitled feed", siteUrl: feedUrl, items };
}

type RawResponse = { status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer };
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

async function requestOnce(url: URL, validators: FeedValidators, address: Awaited<ReturnType<typeof resolvePublicAddress>>): Promise<RawResponse> {
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const options: HttpsRequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    path: `${url.pathname || "/"}${url.search}`,
    method: "GET",
    headers: {
      "user-agent": "PortoFeedReader/1.0 (+https://porto.local)",
      accept: "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
      "accept-encoding": "gzip, deflate, br",
      ...(validators.etag ? { "if-none-match": validators.etag } : {}),
      ...(validators.lastModified ? { "if-modified-since": validators.lastModified } : {}),
    },
    // Connect to the address we validated above while preserving the original host for TLS/SNI.
    lookup: ((_hostname: string, lookupOptions: { all?: boolean }, callback: (...args: any[]) => void) => {
      if (lookupOptions?.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    }) as HttpsRequestOptions["lookup"],
    ...(url.hostname.includes(":") ? {} : { servername: url.hostname }),
  };

  return new Promise<RawResponse>((resolve, reject) => {
    const req = transport(url, options, (res) => {
      res.on("error", reject);
      const status = res.statusCode ?? 0;
      if (REDIRECT_CODES.has(status) || status === 304) {
        res.resume();
        return resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
      }
      const rawLength = res.headers["content-length"];
      if (rawLength && Number(rawLength) > MAX_RESPONSE_BYTES) {
        res.destroy(new Error("Feed response exceeds the size limit"));
        return reject(new Error("Feed response exceeds the size limit"));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_RESPONSE_BYTES) {
          res.destroy(new Error("Feed response exceeds the size limit"));
          return;
        }
        chunks.push(buffer);
      });
      res.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    const timer = setTimeout(() => req.destroy(new Error("Feed request timed out")), REQUEST_TIMEOUT_MS);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
}

async function getResponse(startUrl: URL, validators: FeedValidators): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }> {
  let url = startUrl;
  let activeValidators = validators;
  let response: RawResponse;
  for (let redirects = 0; ; redirects += 1) {
    const address = await resolvePublicAddress(url.hostname.replace(/^\[|\]$/g, ""));
    response = await requestOnce(url, activeValidators, address);
    if (!REDIRECT_CODES.has(response.status)) break;
    const location = response.headers.location;
    if (!location) throw new Error("Feed redirect is missing a destination");
    if (redirects >= MAX_REDIRECTS) throw new Error("Feed redirected too many times");
    const next = parseSafeHttpUrl(new URL(location, url).toString());
    if (next.origin !== url.origin) activeValidators = {};
    url = next;
  }
  if (response.status === 304) return { status: response.status, headers: response.headers, body: "" };
  const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase();
  let decoded = response.body;
  try {
    if (encoding === "gzip" || encoding === "x-gzip") decoded = gunzipSync(decoded, { maxOutputLength: MAX_RESPONSE_BYTES });
    else if (encoding === "deflate") decoded = inflateSync(decoded, { maxOutputLength: MAX_RESPONSE_BYTES });
    else if (encoding === "br") decoded = brotliDecompressSync(decoded, { maxOutputLength: MAX_RESPONSE_BYTES });
    else if (encoding !== "identity") throw new Error("Feed uses an unsupported content encoding");
  } catch {
    throw new Error("Feed response could not be safely decompressed");
  }
  if (decoded.length > MAX_RESPONSE_BYTES) throw new Error("Feed response exceeds the size limit");
  return { status: response.status, headers: response.headers, body: decoded.toString("utf8") };
}

/** Fetches and parses an RSS, RDF, or Atom feed after resolving and pinning a public IP. */
export async function fetchFeed(url: string, validators: FeedValidators = {}): Promise<FetchedFeed> {
  let current = parseSafeHttpUrl(url);
  const response = await getResponse(current, validators);
  const etag = typeof response.headers.etag === "string" ? response.headers.etag : validators.etag ?? null;
  const lastModified = typeof response.headers["last-modified"] === "string" ? response.headers["last-modified"] : validators.lastModified ?? null;
  if (response.status === 304) return { notModified: true, etag, lastModified, items: [] };
  if (response.status < 200 || response.status >= 300) throw new Error(`Feed server returned HTTP ${response.status}`);

  const parsed = await parseFeedXml(response.body);
  return {
    notModified: false,
    title: parsed.title === "Untitled feed" ? current.hostname : parsed.title,
    siteUrl: parsed.siteUrl,
    etag,
    lastModified,
    items: parsed.items,
  };
}
