import { describe, expect, it } from "vitest";
import { parseFeedXml } from "../../src/lib/feeds/fetch";

describe("feed parsing", () => {
  it("parses RSS, strips markup into plain excerpts, and keys by GUID independent of date", async () => {
    const first = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example News</title><link>https://example.com/</link>
      <item><title> A &amp; B </title><link>https://example.com/story?utm_source=rss</link><guid>story-42</guid><pubDate>Tue, 01 Jan 2030 12:00:00 GMT</pubDate><description><![CDATA[<p>Readable <b>summary</b><script>bad()</script></p>]]></description></item>
    </channel></rss>`;
    const second = first.replace("Tue, 01 Jan 2030 12:00:00 GMT", "Wed, 02 Jan 2030 12:00:00 GMT");
    const parsed = await parseFeedXml(first);
    const changedDate = await parseFeedXml(second);
    expect(parsed.title).toBe("Example News");
    expect(parsed.siteUrl).toBe("https://example.com/");
    expect(parsed.items[0]).toMatchObject({ title: "A & B", summary: "Readable summary", published_at: "2030-01-01T12:00:00.000Z" });
    expect(changedDate.items[0].item_key).toBe(parsed.items[0].item_key);
  });

  it("parses Atom and RDF feeds", async () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Source</title><link href="https://atom.example/" rel="alternate"/><entry><id>tag:atom.example,2025:1</id><title>Atom item</title><link href="https://atom.example/item"/><summary>Atom summary</summary></entry></feed>`;
    const rdf = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel rdf:about="https://rdf.example/"><title>RDF Source</title><link>https://rdf.example/</link></channel><item rdf:about="https://rdf.example/item"><title>RDF item</title><link>https://rdf.example/item</link><description>RDF summary</description></item></rdf:RDF>`;
    expect((await parseFeedXml(atom)).items[0]).toMatchObject({ title: "Atom item", url: "https://atom.example/item", summary: "Atom summary" });
    expect((await parseFeedXml(rdf)).items[0]).toMatchObject({ title: "RDF item", url: "https://rdf.example/item", summary: "RDF summary" });
  });

  it("drops unsafe article URLs and does not invent publication dates", async () => {
    const xml = `<rss version="2.0"><channel><title>Source</title><item><title>Bad URL</title><link>javascript:alert(1)</link></item><item><title>No date</title><link>https://example.com/post?b=2&amp;utm_campaign=x</link></item></channel></rss>`;
    const feed = await parseFeedXml(xml);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].published_at).toBeNull();
  });

  it("deduplicates repeated article identities within one feed", async () => {
    const xml = `<rss version="2.0"><channel><title>Source</title>
      <item><title>First copy</title><link>https://example.com/story?utm_source=rss</link></item>
      <item><title>Duplicate copy</title><link>https://example.com/story</link></item>
      <item><title>Same GUID elsewhere</title><link>https://example.com/other</link><guid>same-id</guid></item>
      <item><title>Repeated GUID</title><link>https://example.com/another</link><guid>same-id</guid></item>
    </channel></rss>`;
    const feed = await parseFeedXml(xml);
    expect(feed.items).toHaveLength(2);
    expect(feed.items.map((item) => item.title)).toEqual(["First copy", "Same GUID elsewhere"]);
  });

  it("rejects an excessive item count instead of returning a partial feed", async () => {
    const rows = Array.from({ length: 2_001 }, (_, index) => `<item><title>Item ${index}</title><link>https://example.com/${index}</link></item>`).join("");
    const xml = `<rss version="2.0"><channel><title>Large</title>${rows}</channel></rss>`;
    await expect(parseFeedXml(xml)).rejects.toThrow(/too many items/);
  });

  it("accepts a titled empty feed but rejects an untitled empty channel", async () => {
    const validEmpty = `<rss version="2.0"><channel><title>Quiet source</title></channel></rss>`;
    expect(await parseFeedXml(validEmpty)).toMatchObject({ title: "Quiet source", items: [] });

    const untitledEmpty = `<rss version="2.0"><channel></channel></rss>`;
    await expect(parseFeedXml(untitledEmpty)).rejects.toThrow(/missing its title/);
  });

  it("allows items without a feed title so fetch can use the host as its title", async () => {
    const xml = `<rss version="2.0"><channel><item><title>Story</title><link>https://example.com/story</link></item></channel></rss>`;
    expect(await parseFeedXml(xml)).toMatchObject({ title: "Untitled feed", items: [{ title: "Story" }] });
  });

  it("rejects non-feed XML and malformed feed shapes", async () => {
    await expect(parseFeedXml(`<html><head><title>Maintenance</title></head><body>Try again</body></html>`)).rejects.toThrow(/not an RSS, RDF, or Atom feed/);
    await expect(parseFeedXml(`<rss version="2.0"><item><title>Detached item</title></item></rss>`)).rejects.toThrow(/not an RSS, RDF, or Atom feed/);
    await expect(parseFeedXml(`<rss version="2.0"><channel></rss>`)).rejects.toThrow(/valid XML/);
  });
});
