import { afterEach, describe, expect, it } from "bun:test";
import {
  assertSafeOutboundUrl,
  guardedFetch,
  isLinkLocalAddress,
  isNonPublicAddress,
  MAX_OUTBOUND_REDIRECTS,
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

describe("isNonPublicAddress", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fe80::1%en0",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
    "::ffff:7f00:1",
    "::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:c0a8:101::1",
    "not an address",
  ])("refuses %s", (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "100.128.0.1",
    "172.32.0.1",
    "192.167.1.1",
    "140.82.112.3",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ])("allows %s", (address) => {
    expect(isNonPublicAddress(address)).toBe(false);
  });
});

describe("resolveOutboundTarget lookups", () => {
  it("pins to the address the check saw, whatever a later lookup would answer", async () => {
    const answers = [["10.0.0.5"], ["169.254.169.254"], ["169.254.169.254"]];
    let lookups = 0;
    const target = await resolveOutboundTarget("http://rebind.test/", async () => answers[lookups++]);
    expect(lookups).toBe(1);
    expect(target.requestUrl).toBe("http://10.0.0.5/");
    expect(target.headers).toEqual({ Host: "rebind.test" });
  });
});

describe("guardedFetch", () => {
  interface Seen {
    url: string;
    method?: string;
    body?: unknown;
    headers: Record<string, string>;
  }

  /**
   * A fake network: each request takes the next reply. `abortedBefore[i]` says
   * which earlier requests were already aborted when request i was sent.
   */
  function network(...replies: Array<() => Response>) {
    const seen: Seen[] = [];
    const signals: AbortSignal[] = [];
    const abortedBefore: boolean[][] = [];
    const fetchImpl = (async (input: any, init?: RequestInit) => {
      abortedBefore.push(signals.map((signal) => signal.aborted));
      signals.push(init!.signal!);
      seen.push({
        url: String(input),
        method: init?.method,
        body: init?.body ?? undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      const reply = replies[seen.length - 1];
      if (!reply) throw new Error(`unexpected request to ${input}`);
      return reply();
    }) as typeof fetch;
    return { seen, fetchImpl, signals, abortedBefore };
  }

  const redirect = (location: string, status = 302) => () =>
    new Response(null, { status, headers: { location } });
  const ok = () => new Response("done");
  const publicName = async () => ["1.1.1.1"];

  it("follows a redirect and checks the next hop too", async () => {
    const { seen, fetchImpl } = network(redirect("https://example.net/final"), ok);
    const response = await guardedFetch("https://example.com/start", {}, { resolver: publicName, fetchImpl });
    expect(await response.text()).toBe("done");
    expect(seen.map((request) => request.url)).toEqual([
      "https://example.com/start",
      "https://example.net/final",
    ]);
  });

  it("refuses a redirect to the metadata address before sending anything there", async () => {
    const { seen, fetchImpl } = network(redirect("http://169.254.169.254/latest/meta-data/"));
    await expect(
      guardedFetch("https://example.com/start", {}, { resolver: publicName, fetchImpl })
    ).rejects.toBeInstanceOf(OutboundUrlError);
    expect(seen).toHaveLength(1);
  });

  it("refuses a redirect to a name that resolves to the metadata address", async () => {
    const { seen, fetchImpl } = network(redirect("http://evil.test/"));
    const resolver = async (name: string) =>
      name === "evil.test" ? ["169.254.169.254"] : ["1.1.1.1"];
    await expect(
      guardedFetch("https://example.com/start", {}, { resolver, fetchImpl })
    ).rejects.toBeInstanceOf(OutboundUrlError);
    expect(seen).toHaveLength(1);
  });

  it("looks a name up on every request, so a rebind after the last check is refused", async () => {
    const { seen, fetchImpl } = network(ok);
    const answers = [["10.0.0.5"], ["169.254.169.254"]];
    let lookups = 0;
    const resolver = async () => answers[lookups++];

    await guardedFetch("http://rebind.test/one", {}, { resolver, fetchImpl });
    expect(seen[0].url).toBe("http://10.0.0.5/one");

    await expect(
      guardedFetch("http://rebind.test/two", {}, { resolver, fetchImpl })
    ).rejects.toBeInstanceOf(OutboundUrlError);
    expect(seen).toHaveLength(1);
  });

  it("pins every plain http hop to its own address and Host", async () => {
    const { seen, fetchImpl } = network(redirect("http://two.test/b"), ok);
    const resolver = async (name: string) => (name === "one.test" ? ["10.0.0.1"] : ["10.0.0.2"]);
    await guardedFetch("http://one.test/a", {}, { resolver, fetchImpl });
    expect(seen.map((request) => [request.url, request.headers.host])).toEqual([
      ["http://10.0.0.1/a", "one.test"],
      ["http://10.0.0.2/b", "two.test"],
    ]);
  });

  it("resolves a relative redirect against the name, not the pinned address", async () => {
    const { seen, fetchImpl } = network(redirect("/moved"), ok);
    await guardedFetch("http://one.test/a", {}, { resolver: async () => ["10.0.0.1"], fetchImpl });
    expect(seen[1].url).toBe("http://10.0.0.1/moved");
    expect(seen[1].headers.host).toBe("one.test");
  });

  it("keeps credentials on the same host and on an upgrade to https", async () => {
    const { seen, fetchImpl } = network(
      redirect("https://git.test/a"),
      redirect("https://git.test/b"),
      ok
    );
    await guardedFetch(
      "http://git.test/start",
      { headers: { "PRIVATE-TOKEN": "secret", Authorization: "token secret" } },
      { resolver: publicName, fetchImpl }
    );
    for (const request of seen) {
      expect(request.headers["private-token"]).toBe("secret");
      expect(request.headers.authorization).toBe("token secret");
    }
  });

  it("drops credentials, custom ones included, when a redirect leaves the host", async () => {
    const { seen, fetchImpl } = network(redirect("https://other.test/a"), ok);
    await guardedFetch(
      "https://git.test/start",
      {
        headers: {
          Accept: "application/json",
          "PRIVATE-TOKEN": "secret",
          Authorization: "token secret",
          "X-Anything": "secret",
        },
      },
      { resolver: publicName, fetchImpl }
    );
    expect(seen[1].headers).toEqual({ accept: "application/json" });
  });

  it("does not put credentials back after leaving the host and returning", async () => {
    const { seen, fetchImpl } = network(
      redirect("https://other.test/a"),
      redirect("https://git.test/b"),
      ok
    );
    await guardedFetch(
      "https://git.test/start",
      { headers: { Authorization: "token secret" } },
      { resolver: publicName, fetchImpl }
    );
    expect(seen[2].headers.authorization).toBeUndefined();
  });

  it("drops credentials on a downgrade from https to http on the same host", async () => {
    const { seen, fetchImpl } = network(redirect("http://git.test/a"), ok);
    await guardedFetch(
      "https://git.test/start",
      { headers: { Authorization: "token secret" } },
      { resolver: publicName, fetchImpl }
    );
    expect(seen[1].headers.authorization).toBeUndefined();
  });

  it("treats methods the way fetch does", async () => {
    const send = async (status: number, method: string): Promise<Record<string, unknown>> => {
      const { seen, fetchImpl } = network(redirect("https://git.test/b", status), ok);
      await guardedFetch(
        "https://git.test/a",
        { method, body: "{}", headers: { "Content-Type": "application/json" } },
        { resolver: publicName, fetchImpl }
      );
      return {
        method: seen[1].method,
        body: seen[1].body,
        contentType: seen[1].headers["content-type"],
      };
    };
    const kept = (method: string) => ({ method, body: "{}", contentType: "application/json" });
    const asGet = { method: "GET", body: undefined, contentType: undefined };

    expect(await send(301, "POST")).toEqual(asGet);
    expect(await send(302, "POST")).toEqual(asGet);
    expect(await send(303, "POST")).toEqual(asGet);
    expect(await send(303, "PATCH")).toEqual(asGet);
    expect(await send(307, "POST")).toEqual(kept("POST"));
    expect(await send(308, "PATCH")).toEqual(kept("PATCH"));
    expect(await send(301, "PATCH")).toEqual(kept("PATCH"));
  });

  it("stops a redirect loop", async () => {
    const replies = new Array(MAX_OUTBOUND_REDIRECTS + 1).fill(redirect("https://git.test/loop"));
    const { seen, fetchImpl } = network(...replies);
    await expect(
      guardedFetch("https://git.test/start", {}, { resolver: publicName, fetchImpl })
    ).rejects.toThrow("Stopped after");
    expect(seen).toHaveLength(MAX_OUTBOUND_REDIRECTS + 1);
  });

  // Bun keeps reading a cancelled body; only an aborted request closes.
  describe("closing what it does not return", () => {
    it("aborts each redirect before following it, and leaves the response it returns open", async () => {
      const net = network(redirect("https://git.test/b"), redirect("https://git.test/c"), ok);

      const response = await guardedFetch("https://git.test/a", {}, { resolver: publicName, fetchImpl: net.fetchImpl });

      expect(await response.text()).toBe("done");
      expect(net.abortedBefore).toEqual([[], [true], [true, true]]);
      expect(net.signals[2].aborted).toBe(false);
    });

    it("aborts the last redirect when it stops at the limit", async () => {
      const net = network(redirect("https://git.test/b"), redirect("https://git.test/c"));

      await expect(
        guardedFetch("https://git.test/a", {}, { maxRedirects: 1, resolver: publicName, fetchImpl: net.fetchImpl })
      ).rejects.toThrow("Stopped after 1 redirects");
      expect(net.signals.map((signal) => signal.aborted)).toEqual([true, true]);
    });

    it("aborts a redirect it refuses", async () => {
      for (const location of ["http://[::1", "http://169.254.169.254/", "ftp://git.test/file"]) {
        const net = network(redirect(location));

        await expect(
          guardedFetch("https://git.test/a", {}, { resolver: publicName, fetchImpl: net.fetchImpl })
        ).rejects.toBeInstanceOf(OutboundUrlError);
        expect(net.signals[0].aborted).toBe(true);
      }
    });

    it("leaves a redirect it hands back open", async () => {
      const net = network(redirect("https://other.test/"));

      await guardedFetch("https://git.test/", {}, { maxRedirects: 0, resolver: publicName, fetchImpl: net.fetchImpl });

      expect(net.signals[0].aborted).toBe(false);
    });

    it("passes the caller's abort on to the request in flight", async () => {
      const caller = new AbortController();
      const net = network(redirect("https://git.test/b"), ok);

      await guardedFetch("https://git.test/a", { signal: caller.signal }, { resolver: publicName, fetchImpl: net.fetchImpl });
      expect(net.signals[1].aborted).toBe(false);
      caller.abort();
      expect(net.signals[1].aborted).toBe(true);
    });

    it("closes the connections of real redirects with endless bodies", async () => {
      // A raw server: every request gets a 302 whose chunked body never ends.
      const sockets: Array<{ closed: boolean; timer?: ReturnType<typeof setInterval> }> = [];
      const chunk = `4000\r\n${"x".repeat(0x4000)}\r\n`;
      const server = Bun.listen<{ index: number }>({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          open(socket) {
            socket.data = { index: sockets.push({ closed: false }) - 1 };
          },
          data(socket) {
            const state = sockets[socket.data.index];
            if (state.timer) return;
            socket.write("HTTP/1.1 302 Found\r\nLocation: /next\r\nTransfer-Encoding: chunked\r\n\r\n");
            state.timer = setInterval(() => socket.write(chunk), 5);
          },
          close(socket) {
            const state = sockets[socket.data.index];
            clearInterval(state.timer);
            state.closed = true;
          },
        },
      });

      try {
        await expect(
          // Bun.fetch: other test files replace the global fetch.
          guardedFetch(`http://127.0.0.1:${server.port}/start`, {}, { maxRedirects: 2, fetchImpl: Bun.fetch })
        ).rejects.toThrow("Stopped after 2 redirects");
        for (let waited = 0; waited < 2000 && sockets.some((s) => !s.closed); waited += 20) {
          await Bun.sleep(20);
        }
        expect(sockets).toHaveLength(3);
        expect(sockets.map((s) => s.closed)).toEqual([true, true, true]);
      } finally {
        for (const s of sockets) clearInterval(s.timer);
        server.stop(true);
      }
    });
  });

  it("hands a redirect back at maxRedirects 0, and one without a location always", async () => {
    let net = network(redirect("https://other.test/"));
    let response = await guardedFetch(
      "https://git.test/",
      {},
      { maxRedirects: 0, resolver: publicName, fetchImpl: net.fetchImpl }
    );
    expect(response.status).toBe(302);
    expect(net.seen).toHaveLength(1);

    net = network(() => new Response(null, { status: 302 }));
    response = await guardedFetch("https://git.test/", {}, { resolver: publicName, fetchImpl: net.fetchImpl });
    expect(response.status).toBe(302);
  });

  it("refuses a redirect to another scheme", async () => {
    const { fetchImpl } = network(redirect("ftp://git.test/file"));
    await expect(
      guardedFetch("https://git.test/", {}, { resolver: publicName, fetchImpl })
    ).rejects.toBeInstanceOf(OutboundUrlError);
  });

  it("still allows private networks without publicOnly", async () => {
    const { seen, fetchImpl } = network(ok);
    await guardedFetch("http://gitlab:8929/api", {}, { resolver: async () => ["172.18.0.4"], fetchImpl });
    expect(seen[0].url).toBe("http://172.18.0.4:8929/api");
  });

  describe("publicOnly", () => {
    const options = (extra: object = {}) => ({ publicOnly: true, ...extra });

    it.each([
      "http://127.0.0.1:3000/x",
      "http://10.0.0.1/x",
      "http://192.168.1.1/x",
      "https://172.16.0.1/x",
      "http://[::1]/x",
      "http://[::ffff:7f00:1]/x",
      "http://169.254.169.254/x",
      "http://2130706433/x",
      "http://0x7f.0.0.1/x",
      "http://metadata.google.internal/x",
    ])("refuses %s before any request", async (url) => {
      const { seen, fetchImpl } = network();
      await expect(
        guardedFetch(url, {}, options({ resolver: publicName, fetchImpl }))
      ).rejects.toBeInstanceOf(OutboundUrlError);
      expect(seen).toHaveLength(0);
    });

    it("refuses a name when any of its addresses is private", async () => {
      const { seen, fetchImpl } = network();
      await expect(
        guardedFetch(
          "https://mixed.test/x",
          {},
          options({ resolver: async () => ["1.1.1.1", "192.168.1.1"], fetchImpl })
        )
      ).rejects.toThrow("not public");
      expect(seen).toHaveLength(0);
    });

    it("refuses a name that does not resolve, because fetch could resolve it differently", async () => {
      const { seen, fetchImpl } = network();
      await expect(
        guardedFetch("http://flaky.test/x", {}, options({ resolver: noResolve, fetchImpl }))
      ).rejects.toThrow("could not be resolved");
      expect(seen).toHaveLength(0);
    });

    it("applies to every hop", async () => {
      const { seen, fetchImpl } = network(redirect("http://192.168.1.1/admin"));
      await expect(
        guardedFetch("https://example.com/x", {}, options({ resolver: publicName, fetchImpl }))
      ).rejects.toBeInstanceOf(OutboundUrlError);
      expect(seen).toHaveLength(1);
    });

    it("allows a public URL", async () => {
      const { seen, fetchImpl } = network(ok);
      const response = await guardedFetch(
        "https://example.com/x",
        {},
        options({ resolver: publicName, fetchImpl })
      );
      expect(response.status).toBe(200);
      expect(seen[0].url).toBe("https://example.com/x");
    });
  });
});
