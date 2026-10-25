import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { parseSafeHttpUrl } from "./safe-url";

export type OpmlSource = { url: string; title: string; folder: string | null; site_url: string | null };
export type OpmlBuildSource = { url: string; title: string; folder: string | null; site_url?: string | null };

const MAX_OPML_BYTES = 2 * 1024 * 1024;
const MAX_OPML_SOURCES = 2_000;
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
});
const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true,
  processEntities: true,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function validHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return parseSafeHttpUrl(value.trim()).toString(); }
  catch { return null; }
}

/** Reads RSS outlines from an OPML document, carrying nested folder names as slash paths. */
export function parseOpml(xml: string): OpmlSource[] {
  if (typeof xml !== "string" || Buffer.byteLength(xml, "utf8") > MAX_OPML_BYTES) throw new Error("OPML document exceeds the size limit");
  const document = parser.parse(xml) as Record<string, any>;
  const outlines = asArray(document?.opml?.body?.outline);
  const sources: OpmlSource[] = [];

  const visit = (nodes: any[], ancestors: string[]) => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const xmlUrl = validHttpUrl(node["@_xmlUrl"] ?? node["@_xmlurl"]);
      if (xmlUrl) {
        if (sources.length >= MAX_OPML_SOURCES) throw new Error("OPML document contains too many feeds");
        const title = String(node["@_title"] || node["@_text"] || node["#text"] || xmlUrl).trim();
        sources.push({
          url: xmlUrl,
          title: title || xmlUrl,
          folder: ancestors.length ? ancestors.join("/") : null,
          site_url: validHttpUrl(node["@_htmlUrl"] ?? node["@_htmlurl"]),
        });
        continue;
      }

      const label = String(node["@_text"] || node["@_title"] || "").trim();
      const nested = asArray(node.outline);
      if (nested.length) visit(nested, label ? [...ancestors, label] : ancestors);
    }
  };

  visit(outlines, []);
  return sources;
}

/** Builds a portable OPML 2.0 document, grouping sources into nested folders. */
export function buildOpml(sources: OpmlBuildSource[]): string {
  if (sources.length > MAX_OPML_SOURCES) throw new Error("Too many feeds to export as OPML");
  const root: Record<string, any> = { opml: { "@_version": "2.0", head: { title: "Porto feeds" }, body: { outline: [] as any[] } } };
  const folderMaps = new Map<string, Map<string, any>>();
  const body = root.opml.body;

  for (const source of sources) {
    const feedUrl = validHttpUrl(source.url);
    if (!feedUrl) continue;
    const segments = (source.folder ?? "").split("/").map((part) => part.trim()).filter(Boolean);
    let destination = body.outline as any[];
    let path = "";
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment;
      let foldersAtLevel = folderMaps.get(path);
      if (!foldersAtLevel) {
        foldersAtLevel = new Map();
        folderMaps.set(path, foldersAtLevel);
      }
      let folder = foldersAtLevel.get(segment);
      if (!folder) {
        folder = { "@_text": segment, "@_title": segment, outline: [] as any[] };
        foldersAtLevel.set(segment, folder);
        destination.push(folder);
      }
      destination = folder.outline;
    }
    const title = source.title.trim() || feedUrl;
    const feed: Record<string, string> = {
      "@_type": "rss",
      "@_text": title,
      "@_title": title,
      "@_xmlUrl": feedUrl,
    };
    const siteUrl = validHttpUrl(source.site_url);
    if (siteUrl) feed["@_htmlUrl"] = siteUrl;
    destination.push(feed);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(root)}`;
}
