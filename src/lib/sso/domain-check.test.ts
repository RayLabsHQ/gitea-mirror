import { describe, expect, it } from "bun:test";
import { domainIsIssuerHost } from "./domain-check";

describe("domainIsIssuerHost", () => {
  it("flags a Domain that is the issuer's hostname", () => {
    expect(domainIsIssuerHost("accounts.google.com", "https://accounts.google.com")).toBe(true);
    expect(domainIsIssuerHost("auth.example.com", "https://auth.example.com/application/o/gm/")).toBe(true);
    expect(domainIsIssuerHost(" Auth.Example.com ", "https://auth.example.com")).toBe(true);
    expect(domainIsIssuerHost("example.com", "https://www.example.com")).toBe(true);
    expect(domainIsIssuerHost("example.org, auth.example.com", "https://auth.example.com")).toBe(true);
  });

  it("accepts an email domain", () => {
    expect(domainIsIssuerHost("example.com", "https://auth.example.com")).toBe(false);
    expect(domainIsIssuerHost("gmail.com", "https://accounts.google.com")).toBe(false);
    expect(domainIsIssuerHost("example.com, example.org", "https://auth.example.com")).toBe(false);
  });

  it("does not flag when either side is missing or not a URL", () => {
    expect(domainIsIssuerHost("", "https://auth.example.com")).toBe(false);
    expect(domainIsIssuerHost(null, "https://auth.example.com")).toBe(false);
    expect(domainIsIssuerHost("auth.example.com", "")).toBe(false);
    expect(domainIsIssuerHost("auth.example.com", "not a url")).toBe(false);
    expect(domainIsIssuerHost("auth.example.com", undefined)).toBe(false);
  });
});
