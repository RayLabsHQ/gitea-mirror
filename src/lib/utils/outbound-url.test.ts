import { afterEach, describe, expect, it } from "bun:test";
import {
  assertSafeOutboundUrl,
  isLinkLocalAddress,
  OutboundUrlError,
  resolveOutboundTarget,
  safeFetch,
} from "./outbound-url";

const noResolve = async () => [];

describe("isLinkLocalAddress", () => {
  it("matches the IPv4 link local range", () => {
    expect(isLinkLocalAddress("169.254.169.254")).toBe(true);
    expect(isLinkLocalAddress("169.254.0.1")).toBe(true);
    expect(isLinkLocalAddress("169.253.1.1")).toBe(false);
    expect(isLinkLocalAddress("10.0.0.1")).toBe(false);
    expect(isLinkLocalAddress("192.168.1.10")).toBe(false);
    expect(isLinkLocalAddress("127.0.0.1")).toBe(false);
  });

  it("matches IPv6 link local and the mapped IPv4 forms", () => {
    expect(isLinkLocalAddress("fe80::1")).toBe(true);
    expect(isLinkLocalAddress("FE9A::1")).toBe(true);
    expect(isLinkLocalAddress("febf::1")).toBe(true);
    expect(isLinkLocalAddress("fec0::1")).toBe(false);
    expect(isLinkLocalAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isLinkLocalAddress("::ffff:a9fe:a9fe")).toBe(true);
    expect(isLinkLocalAddress("::ffff:192.168.1.1")).toBe(false);
    expect(isLinkLocalAddress("::1")).toBe(false);
    expect(isLinkLocalAddress("not-an-ip")).toBe(false);
  });
});

describe("assertSafeOutboundUrl", () => {
  it("allows private networks, localhost and Docker service names", async () => {
    for (const url of [
      "http://192.168.1.10:3000",
      "http://10.0.0.5",
      "http://172.16.4.4:8080/api",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://gitea:3000",
      "https://codeberg.org",
    ]) {
      await expect(assertSafeOutboundUrl(url, noResolve)).resolves.toBeInstanceOf(URL);
    }
  });

  it("refuses the metadata address in every spelling", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://[fe80::1]/",
      "http://[::ffff:169.254.169.254]/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://METADATA/",
    ]) {
      await expect(assertSafeOutboundUrl(url, noResolve)).rejects.toBeInstanceOf(OutboundUrlError);
    }
  });

  it("refuses a host name that resolves to a link local address", async () => {
    const resolver = async () => ["93.184.216.34", "169.254.169.254"];
    await expect(assertSafeOutboundUrl("http://evil.example/", resolver)).rejects.toThrow(
      /link local/
    );
  });

  it("leaves unresolvable names to fetch", async () => {
    await expect(assertSafeOutboundUrl("http://nope.invalid/", noResolve)).resolves.toBeInstanceOf(
      URL
    );
  });

  it("refuses other schemes and malformed URLs", async () => {
    await expect(assertSafeOutboundUrl("file:///etc/passwd", noResolve)).rejects.toThrow(
      /http and https/
    );
    await expect(assertSafeOutboundUrl("gopher://x/", noResolve)).rejects.toThrow(/http and https/);
    await expect(assertSafeOutboundUrl("not a url", noResolve)).rejects.toThrow(/Invalid URL/);
  });
});

describe("resolveOutboundTarget", () => {
  it("pins plain http to the checked address and keeps the name in Host", async () => {
    const resolver = async () => ["10.0.0.5", "10.0.0.6"];
    const target = await resolveOutboundTarget("http://ntfy.local:8080/topic?x=1", resolver);
    expect(target.requestUrl).toBe("http://10.0.0.5:8080/topic?x=1");
    expect(target.headers).toEqual({ Host: "ntfy.local:8080" });
  });

  it("brackets a pinned IPv6 address", async () => {
    const resolver = async () => ["fd00::10"];
    const target = await resolveOutboundTarget("http://gotify.local/message", resolver);
    expect(target.requestUrl).toBe("http://[fd00::10]/message");
    expect(target.headers).toEqual({ Host: "gotify.local" });
  });

  it("does not pin https, IP literals or unresolvable names", async () => {
    const resolver = async () => ["10.0.0.5"];
    expect((await resolveOutboundTarget("https://idp.example.com/x", resolver)).headers).toEqual({});
    expect((await resolveOutboundTarget("http://192.168.1.10:3000/", resolver)).requestUrl).toBe(
      "http://192.168.1.10:3000/"
    );
    const unresolved = await resolveOutboundTarget("http://nope.invalid/", noResolve);
    expect(unresolved.requestUrl).toBe("http://nope.invalid/");
    expect(unresolved.headers).toEqual({});
  });
});

describe("safeFetch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("never follows redirects, pins the address and refuses blocked hosts before fetching", async () => {
    let seen: any = null;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = { url: String(input), redirect: init?.redirect, host: headers.get("host"), auth: headers.get("authorization") };
      return new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } });
    }) as typeof fetch;

    const resolver = async () => ["10.0.0.5"];
    const response = await safeFetch(
      "http://ntfy.local/topic",
      { method: "POST", headers: { Authorization: "Bearer t" } },
      resolver
    );
    expect(response.status).toBe(302);
    expect(seen).toEqual({
      url: "http://10.0.0.5/topic",
      redirect: "manual",
      host: "ntfy.local",
      auth: "Bearer t",
    });

    seen = null;
    await expect(safeFetch("http://169.254.169.254/", {}, noResolve)).rejects.toBeInstanceOf(
      OutboundUrlError
    );
    expect(seen).toBeNull();
  });
});
