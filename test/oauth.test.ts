import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_USER,
  Browser,
  REDIRECT_URI,
  authorizePath,
  consentForm,
  exchangeCode,
  getAccessToken,
  handleFrom,
  registerClient,
  send,
  signIn,
  stubGitHub,
} from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

const mcpPing = (token?: string) =>
  send("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });

describe("protection of /mcp", () => {
  it("challenges a request without a token and points to the metadata", async () => {
    const response = await mcpPing();
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  it("rejects a forged token", async () => {
    expect((await mcpPing("user:grant:forged")).status).toBe(401);
  });

  it("publishes the endpoints MCP clients discover", async () => {
    const metadata = (await (
      await send("/.well-known/oauth-authorization-server")
    ).json()) as Record<string, string>;
    expect(metadata.authorization_endpoint).toMatch(/\/authorize$/);
    expect(metadata.token_endpoint).toMatch(/\/token$/);
    expect(metadata.registration_endpoint).toMatch(/\/register$/);
  });
});

describe("sign-in", () => {
  it("issues a working token to the allowed GitHub account", async () => {
    const token = await getAccessToken();
    expect((await mcpPing(token)).status).toBe(200);
  });

  it("sends GitHub a PKCE challenge and no client secret", async () => {
    const browser = new Browser();
    const page = await browser.fetch(await authorizePath(await registerClient()));
    const redirect = await browser.fetch(
      "/authorize",
      consentForm(handleFrom(await page.text())),
    );
    const location = new URL(redirect.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
    expect(location.searchParams.has("client_secret")).toBe(false);
  });

  it("refuses every other GitHub account, even with the allowed login name", async () => {
    stubGitHub({ id: ALLOWED_USER.id + 1, login: ALLOWED_USER.login });
    const clientId = await registerClient();
    const response = await signIn(new Browser(), clientId);

    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.has("code")).toBe(false);
  });

  it("shows an error page when GitHub rejects the code", async () => {
    stubGitHub(null);
    const response = await signIn(new Browser(), await registerClient());
    expect(response.status).toBe(502);
    expect(response.headers.has("Location")).toBe(false);
  });

  it("returns access_denied when the user declines on GitHub", async () => {
    const browser = new Browser();
    const page = await browser.fetch(await authorizePath(await registerClient()));
    const redirect = await browser.fetch(
      "/authorize",
      consentForm(handleFrom(await page.text())),
    );
    const state = new URL(redirect.headers.get("Location")!).searchParams.get("state")!;

    const response = await browser.fetch(
      `/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("client-state");
  });
});

describe("consent page", () => {
  it("escapes the client's name and shows where access goes", async () => {
    const clientId = await registerClient('<script>alert("x")</script>');
    const response = await new Browser().fetch(await authorizePath(clientId));
    const html = await response.text();

    expect(html).not.toContain("<script>");
    expect(html).toContain("localhost");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("returns access_denied when the user clicks deny, without calling GitHub", async () => {
    const browser = new Browser();
    const page = await browser.fetch(await authorizePath(await registerClient()));
    const response = await browser.fetch(
      "/authorize",
      consentForm(handleFrom(await page.text()), "deny"),
    );
    const location = response.headers.get("Location")!;
    expect(location.startsWith(REDIRECT_URI)).toBe(true);
    expect(new URL(location).searchParams.get("error")).toBe("access_denied");
  });

  it("refuses an approval from a browser that didn't open the page", async () => {
    const page = await new Browser().fetch(await authorizePath(await registerClient()));
    const response = await new Browser().fetch(
      "/authorize",
      consentForm(handleFrom(await page.text())),
    );
    expect(response.status).toBe(400);
    expect(response.headers.has("Location")).toBe(false);
  });

  it("refuses to reuse an approval", async () => {
    const browser = new Browser();
    const page = await browser.fetch(await authorizePath(await registerClient()));
    const form = consentForm(handleFrom(await page.text()));
    expect((await browser.fetch("/authorize", form)).status).toBe(302);
    const again = await browser.fetch(
      "/authorize",
      consentForm(new URLSearchParams(form.body).get("handle")!),
    );
    expect(again.status).toBe(400);
  });
});

describe("confused deputy", () => {
  it("doesn't complete a callback in a victim's browser", async () => {
    const github = stubGitHub(ALLOWED_USER);

    // The attacker approves their own malicious client, then lures the victim,
    // who is already signed in to GitHub, through the resulting link.
    const attacker = new Browser();
    const page = await attacker.fetch(await authorizePath(await registerClient("Evil")));
    const redirect = await attacker.fetch(
      "/authorize",
      consentForm(handleFrom(await page.text())),
    );
    const state = new URL(redirect.headers.get("Location")!).searchParams.get("state")!;

    const victim = new Browser();
    const response = await victim.fetch(
      `/callback?code=victim-code&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(400);
    expect(response.headers.has("Location")).toBe(false);
    expect(github).not.toHaveBeenCalled();
  });

  it("refuses a made-up state", async () => {
    const response = await new Browser().fetch("/callback?code=x&state=made-up");
    expect(response.status).toBe(400);
  });

  it("only exchanges a code once, and only with the PKCE verifier", async () => {
    stubGitHub(ALLOWED_USER);
    const clientId = await registerClient();
    const done = await signIn(new Browser(), clientId);
    const code = new URL(done.headers.get("Location")!).searchParams.get("code")!;

    const response = await send("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: "wrong".repeat(10),
      }),
    });
    expect(response.status).toBe(400);

    expect((await exchangeCode(clientId, code)).ok).toBe(true);
    expect((await exchangeCode(clientId, code)).ok).toBe(false);
  });

  it("refuses an unregistered redirect URI without redirecting to it", async () => {
    const clientId = await registerClient();
    const path = (await authorizePath(clientId)).replace(
      encodeURIComponent(REDIRECT_URI),
      encodeURIComponent("https://evil.test/callback"),
    );
    const response = await new Browser().fetch(path);
    expect(response.status).toBe(400);
    expect(response.headers.has("Location")).toBe(false);
  });
});

describe("routing", () => {
  it("returns 404 for unknown paths", async () => {
    expect((await send("/other")).status).toBe(404);
  });

  it("returns 405 for GET on /mcp with a valid token", async () => {
    const token = await getAccessToken();
    const response = await send("/mcp", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(405);
  });
});
