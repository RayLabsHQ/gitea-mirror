import { beforeAll, describe, expect, test } from "bun:test";
import { decrypt, encrypt, isEncrypted } from "@/lib/utils/encryption";
import {
  SecretHostChangedError,
  mergeNotificationSecrets,
  nextStoredSecret,
  redactNotificationSecrets,
  sameHost,
  savedSecretFor,
  takeRemovedNotificationSecrets,
  urlHost,
  withSavedNotificationSecrets,
} from "./stored-secrets";
import { runsIsolated } from "@/tests/isolated";

// notification-service.test.ts replaces the encryption module for the whole
// process, and these tests need the real one, so they run in a child.
const isChild = runsIsolated(import.meta.path);

beforeAll(() => {
  process.env.ENCRYPTION_SECRET ??= "stored-secrets-test-secret-0123456789";
});

describe.skipIf(!isChild)("urlHost and sameHost", () => {
  test("compare host names only, ignoring case, port, scheme and path", () => {
    expect(urlHost("https://Git.Example.com:3000/sub/")).toBe("git.example.com");
    expect(sameHost("https://git.example.com", "http://GIT.example.com:3000/x")).toBe(true);
    expect(sameHost("https://git.example.com", "https://git.example.org")).toBe(false);
  });

  test("never match an address that does not parse", () => {
    expect(urlHost("")).toBeNull();
    expect(urlHost("not a url")).toBeNull();
    expect(urlHost("ftp://git.example.com")).toBeNull();
    expect(sameHost("", "")).toBe(false);
    expect(sameHost(undefined, "https://git.example.com")).toBe(false);
  });
});

describe.skipIf(!isChild)("nextStoredSecret", () => {
  const saved = () => encrypt("saved-token");

  test("encrypts a new value", () => {
    const value = nextStoredSecret({ label: "token", incoming: " new-token ", stored: saved(), bound: false });
    expect(decrypt(value)).toBe("new-token");
  });

  test("keeps the saved value for an empty or missing one", () => {
    const stored = saved();
    for (const incoming of ["", "   ", undefined, null]) {
      expect(nextStoredSecret({ label: "token", incoming, stored, bound: false })).toBe(stored);
    }
  });

  test("encrypts a saved value that was stored as plain text", () => {
    const value = nextStoredSecret({ label: "token", incoming: "", stored: "plain-token", bound: false });
    expect(isEncrypted(value)).toBeTruthy();
    expect(decrypt(value)).toBe("plain-token");
  });

  test("keeps a bound saved value only on the same host", () => {
    const stored = saved();
    expect(
      nextStoredSecret({
        label: "Gitea token",
        incoming: "",
        stored,
        bound: true,
        storedUrl: "https://git.example.com",
        nextUrl: "https://git.example.com:3000/",
      })
    ).toBe(stored);

    expect(() =>
      nextStoredSecret({
        label: "Gitea token",
        incoming: "",
        stored,
        bound: true,
        storedUrl: "https://git.example.com",
        nextUrl: "https://attacker.example.net",
      })
    ).toThrow(
      new SecretHostChangedError("Gitea token", "https://git.example.com", "https://attacker.example.net")
    );
  });

  test("lets a new value go to a new host", () => {
    const value = nextStoredSecret({
      label: "Gitea token",
      incoming: "fresh",
      stored: saved(),
      bound: true,
      storedUrl: "https://git.example.com",
      nextUrl: "https://git.example.org",
    });
    expect(decrypt(value)).toBe("fresh");
  });

  test("returns empty when nothing is saved", () => {
    expect(
      nextStoredSecret({ label: "t", incoming: "", stored: "", bound: true, storedUrl: "", nextUrl: "https://a.example" })
    ).toBe("");
  });
});

describe.skipIf(!isChild)("savedSecretFor", () => {
  test("decrypts the saved value for the same host only", () => {
    const stored = encrypt("saved-token");
    expect(savedSecretFor(stored, "https://git.example.com", "https://git.example.com/")).toBe("saved-token");
    expect(savedSecretFor(stored, "https://git.example.com", "https://other.example.com")).toBeNull();
    expect(savedSecretFor(undefined, "https://git.example.com", "https://git.example.com")).toBeNull();
  });
});

describe.skipIf(!isChild)("notification secrets", () => {
  const stored = () => ({
    enabled: true,
    provider: "ntfy",
    ntfy: { url: "https://ntfy.example.com", topic: "t", token: encrypt("ntfy-saved"), priority: "default" },
    gotify: { url: "https://gotify.example.com", token: encrypt("gotify-saved"), priority: 5 },
    apprise: { url: "https://apprise.example.com", token: "", tag: "x" },
    webhook: { url: "https://hooks.example.com", secret: encrypt("webhook-saved") },
  });

  test("redaction blanks every secret and says which are saved", () => {
    const redacted = redactNotificationSecrets(stored());
    expect(redacted.ntfy).toMatchObject({ token: "", hasToken: true, topic: "t" });
    expect(redacted.gotify).toMatchObject({ token: "", hasToken: true });
    expect(redacted.apprise).toMatchObject({ token: "", hasToken: false });
    expect(redacted.webhook).toMatchObject({ secret: "", hasSecret: true });
    expect(JSON.stringify(redacted)).not.toContain(stored().ntfy.token.slice(0, 12));
  });

  test("null removes a secret; an empty one keeps it; a new one replaces it", () => {
    const saved = stored();
    const { config, removed } = takeRemovedNotificationSecrets({
      ...redactNotificationSecrets(saved),
      ntfy: { ...saved.ntfy, token: null, hasToken: false },
      gotify: { ...saved.gotify, token: "gotify-new" },
    });
    expect([...removed]).toEqual(["ntfy"]);
    expect((config as any).ntfy).not.toHaveProperty("token");

    const merged = mergeNotificationSecrets(config as any, saved, removed);
    expect(merged.ntfy.token).toBe("");
    expect(decrypt(merged.gotify.token)).toBe("gotify-new");
    expect(merged.webhook.secret).toBe(saved.webhook.secret);
    expect(merged.apprise.token).toBe("");
  });

  test("a saved token does not follow its URL to another host", () => {
    const saved = stored();
    const incoming = { ...redactNotificationSecrets(saved), gotify: { url: "https://evil.example.net", token: "", priority: 5 } };
    expect(() => mergeNotificationSecrets(incoming as any, saved)).toThrow(SecretHostChangedError);
  });

  test("the webhook signing secret is never sent, so it stays when the URL moves", () => {
    const saved = stored();
    const incoming = { ...redactNotificationSecrets(saved), webhook: { url: "https://elsewhere.example.net", secret: "" } };
    const merged = mergeNotificationSecrets(incoming as any, saved);
    expect(merged.webhook.secret).toBe(saved.webhook.secret);
  });

  test("ntfy without a stored URL counts as ntfy.sh", () => {
    const saved = { provider: "ntfy", ntfy: { topic: "t", token: encrypt("ntfy-saved") } };
    const merged = mergeNotificationSecrets(
      { provider: "ntfy", ntfy: { url: "https://ntfy.sh", topic: "t", token: "" } } as any,
      saved
    );
    expect(decrypt(merged.ntfy.token)).toBe("ntfy-saved");
  });

  test("a test send gets the active provider's saved secret, decrypted, and nothing else", () => {
    const saved = stored();
    const incoming = { ...redactNotificationSecrets(saved), provider: "gotify" };
    const forTest = withSavedNotificationSecrets(incoming as any, saved);
    expect(forTest.gotify.token).toBe("gotify-saved");
    expect(forTest).not.toHaveProperty("ntfy");
    expect(forTest).not.toHaveProperty("webhook");
  });

  test("a test send to another host does not get the saved secret", () => {
    const saved = stored();
    const incoming = { provider: "ntfy", ntfy: { url: "https://evil.example.net", topic: "t", token: "" } };
    expect(() => withSavedNotificationSecrets(incoming as any, saved)).toThrow(
      "Enter a ntfy access token for evil.example.net. The saved one is only sent to ntfy.example.com."
    );
  });
});
