import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  httpRequest: vi.fn(),
  httpsRequest: vi.fn(),
  lookup: vi.fn(),
}));

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return { ...actual, request: mocks.httpRequest };
});
vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https")>();
  return { ...actual, request: mocks.httpsRequest };
});
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));

import { fetchFeed } from "../../src/lib/feeds/fetch";

type Reply = { status: number; headers?: Record<string, string>; body?: Buffer | string };
const feedXml = `<rss version="2.0"><channel><title>Redirected Feed</title><link>https://feed.example/</link><item><title>One</title><link>https://feed.example/one</link><guid>one</guid></item></channel></rss>`;

function installReplies(replies: Reply[]) {
  const requests: Array<{ url: URL; options: any }> = [];
  const transport = vi.fn((url: URL, options: any, onResponse: (response: any) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error: Error) => void };
    req.end = () => {
      const reply = replies[requests.length];
      requests.push({ url: new URL(url.toString()), options });
      if (!reply) throw new Error("No mocked response available");
      queueMicrotask(() => {
        const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; resume: () => void; destroy: (error: Error) => void };
        res.statusCode = reply.status;
        res.headers = reply.headers ?? {};
        res.resume = () => req.emit("close");
        res.destroy = (error) => { req.emit("close"); queueMicrotask(() => res.emit("error", error)); };
        onResponse(res);
        if ([301, 302, 303, 307, 308, 304].includes(reply.status)) return;
        const body = reply.body ?? "";
        queueMicrotask(() => {
          res.emit("data", body);
          res.emit("end");
          req.emit("close");
        });
      });
    };
    req.destroy = (error) => req.emit("error", error);
    return req;
  });
  mocks.httpRequest.mockImplementation(transport as any);
  return requests;
}

describe("safe feed fetching", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.lookup.mockResolvedValue([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "8.8.8.8", family: 4 },
    ]);
  });

  it("follows redirects and decompresses the final response exactly once", async () => {
    const requests = installReplies([
      { status: 302, headers: { location: "/final" } },
      { status: 200, headers: { "content-encoding": "gzip" }, body: gzipSync(feedXml) },
    ]);
    const result = await fetchFeed("http://feed.example/start");
    expect(result.title).toBe("Redirected Feed");
    expect(result.items).toHaveLength(1);
    expect(requests.map(({ url }) => url.pathname)).toEqual(["/start", "/final"]);
    for (const { options } of requests) {
      await new Promise<void>((resolve, reject) => options.lookup("feed.example", {}, (error: Error | null, address: string) => {
        if (error) reject(error);
        else { expect(address).toBe("8.8.8.8"); resolve(); }
      }));
    }
  });

  it("returns validators and no items for 304 responses", async () => {
    const requests = installReplies([{ status: 304, headers: {} }]);
    const result = await fetchFeed("http://feed.example/rss", { etag: '"v1"', lastModified: "Wed, 21 Oct 2015 07:28:00 GMT" });
    expect(result).toMatchObject({ notModified: true, etag: '"v1"', lastModified: "Wed, 21 Oct 2015 07:28:00 GMT", items: [] });
    expect(requests[0].options.headers["if-none-match"]).toBe('"v1"');
    expect(requests[0].options.headers["if-modified-since"]).toBe("Wed, 21 Oct 2015 07:28:00 GMT");
  });

  it("rejects an HTTP 200 HTML error page instead of treating it as an empty feed", async () => {
    installReplies([{ status: 200, headers: { "content-type": "text/html" }, body: "<html><head><title>Unavailable</title></head><body>Try later</body></html>" }]);
    await expect(fetchFeed("http://feed.example/rss")).rejects.toThrow(/not an RSS, RDF, or Atom feed/);
  });

  it("rejects an unsafe redirect before making a second request", async () => {
    const requests = installReplies([{ status: 302, headers: { location: "http://127.0.0.1/private" } }]);
    await expect(fetchFeed("http://feed.example/rss")).rejects.toThrow(/non-public address/);
    expect(requests).toHaveLength(1);
  });

  it("rejects an oversized response from its declared length", async () => {
    installReplies([{ status: 200, headers: { "content-length": String(5 * 1024 * 1024 + 1) } }]);
    await expect(fetchFeed("http://feed.example/rss")).rejects.toThrow(/size limit/);
  });

  it("times out a request that never responds", async () => {
    vi.useFakeTimers();
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error: Error) => void };
    req.end = () => undefined;
    req.destroy = (error) => req.emit("error", error);
    mocks.httpRequest.mockReturnValue(req as any);
    const result = expect(fetchFeed("http://feed.example/rss")).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(12_001);
    await result;
  });
});
