/**
 * sourceFetch goes through the outbound guard (GHSA-p7w3-46pg-mv6h): the
 * source URL is stored by a signed in user, so it gets the same treatment
 * as every other user supplied URL, and the upstream body never lands in
 * the error message.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { OutboundUrlError } from "@/lib/utils/outbound-url";
import { sourceFetch, SourceApiError } from "./http";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("sourceFetch", () => {
  it("refuses a link local source before any request leaves", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      sourceFetch("http://169.254.169.254/api/v1/orgs/x")
    ).rejects.toBeInstanceOf(OutboundUrlError);
    expect(called).toBe(false);
  });

  it("never follows redirects", async () => {
    let redirect: RequestRedirect | undefined;
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { data } = await sourceFetch<unknown[]>("http://192.168.1.10:3000/api/v1/user/repos");
    expect(data).toEqual([]);
    expect(redirect).toBe("manual");
  });

  it("keeps the upstream body out of the error message", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "Forbidden: token lacks scope. cluster=prod" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await sourceFetch("http://192.168.1.10:3000/api/v1/orgs/any/repos");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SourceApiError);
    const error = caught as SourceApiError;
    expect(error.status).toBe(403);
    expect(error.message).toBe(
      "Request to http://192.168.1.10:3000/api/v1/orgs/any/repos failed with status 403"
    );
    expect(error.body).toContain("token lacks scope");
  });
});
