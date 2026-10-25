import { describe, expect, it } from "vitest";
import { buildOpml, parseOpml } from "../../src/lib/feeds/opml";

describe("OPML import and export", () => {
  it("imports RSS feeds with folder paths and site URLs", () => {
    const xml = `<?xml version="1.0"?><opml version="2.0"><head><title>Subscriptions</title></head><body>
      <outline text="News"><outline text="Daily &amp; Local" title="Daily &amp; Local" type="rss" xmlUrl="https://example.com/feed.xml" htmlUrl="https://example.com/" /></outline>
      <outline text="Loose" type="rss" xmlUrl="https://other.example/rss" />
      <outline text="Bad" type="rss" xmlUrl="file:///etc/passwd" />
    </body></opml>`;
    expect(parseOpml(xml)).toEqual([
      { url: "https://example.com/feed.xml", title: "Daily & Local", folder: "News", site_url: "https://example.com/" },
      { url: "https://other.example/rss", title: "Loose", folder: null, site_url: null },
    ]);
  });

  it("round trips escaped titles, URLs, site URLs, and nested folders", () => {
    const sources = [
      { url: "https://example.com/feed?a=1&b=2", title: "Research & Notes", folder: "Work/Reading", site_url: "https://example.com/" },
      { url: "https://music.example/feed", title: "Music", folder: null, site_url: null },
    ];
    const xml = buildOpml(sources);
    expect(xml).toContain("version=\"2.0\"");
    expect(parseOpml(xml)).toEqual(sources.map((source) => ({ ...source, url: new URL(source.url).toString() })));
  });

  it("rejects oversized documents", () => {
    expect(() => parseOpml(" ".repeat(2 * 1024 * 1024 + 1))).toThrow(/size limit/);
  });
});
