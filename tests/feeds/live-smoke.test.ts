import { describe, expect, it } from "vitest";
import { fetchFeed } from "../../src/lib/feeds/fetch";

const live = process.env.PORTO_LIVE_FEEDS === "1";

describe.skipIf(!live)("live feed smoke tests", () => {
  it("fetches and parses xkcd Atom", async () => {
    const feed = await fetchFeed("https://xkcd.com/atom.xml");
    expect(feed.notModified).toBe(false);
    expect(feed.title?.toLowerCase()).toContain("xkcd");
    expect(feed.items.length).toBeGreaterThan(0);
  }, 30_000);

  it("fetches and parses Answer.AI XML feed", async () => {
    const feed = await fetchFeed("https://www.answer.ai/index.xml");
    expect(feed.notModified).toBe(false);
    expect(feed.title).toBeTruthy();
    expect(feed.items.length).toBeGreaterThan(0);
  }, 30_000);
});
