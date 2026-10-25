import { describe, expect, it } from "vitest";
import { isPublicAddress, parseSafeHttpUrl } from "../../src/lib/feeds/safe-url";

describe("feed URL safety", () => {
  it("accepts only credential-free HTTP(S) URLs", () => {
    expect(parseSafeHttpUrl("https://feeds.example.org/rss.xml").hostname).toBe("feeds.example.org");
    expect(() => parseSafeHttpUrl("ftp://feeds.example.org/rss.xml")).toThrow(/HTTP or HTTPS/);
    expect(() => parseSafeHttpUrl("https://name:secret@feeds.example.org/rss.xml")).toThrow(/credentials/);
    expect(() => parseSafeHttpUrl("not a url")).toThrow(/invalid/);
  });

  it("rejects private, loopback, link-local, documentation, and reserved IP ranges", () => {
    for (const address of [
      "0.1.2.3", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.31.2.3",
      "192.0.2.1", "192.168.1.1", "198.18.0.1", "203.0.113.9", "224.0.0.1", "255.1.2.3",
      "::1", "::ffff:192.168.1.1", "fc00::1", "fe80::1", "2001:db8::1", "ff02::1",
    ]) expect(isPublicAddress(address), address).toBe(false);
  });

  it("accepts globally routable IPv4 and IPv6 examples", () => {
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
});
