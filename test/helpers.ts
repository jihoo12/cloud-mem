import { env, exports } from "cloudflare:workers";
import { vi } from "vitest";

export const BASE = env.PUBLIC_ORIGIN;
export const REDIRECT_URI = "http://localhost:9999/callback";

export const ALLOWED_USER = {
  id: Number(env.GITHUB_ALLOWED_USER_ID),
  login: "jihoo12",
};

export const send = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(new URL(path, BASE), init));

/** A tiny browser cookie jar, because the OAuth flow binds itself to cookies. */
export class Browser {
  private cookies = new Map<string, string>();

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) headers.set("Cookie", cookie);
    const response = await send(path, { ...init, headers, redirect: "manual" });
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const index = pair.indexOf("=");
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
}

export async function registerClient(name = "Test client") {
  const response = await send("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!response.ok) throw new Error(`register: ${await response.text()}`);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function s256(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export const PKCE_VERIFIER = "test-verifier-".repeat(4);

export async function authorizePath(clientId: string) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state: "client-state",
    code_challenge: await s256(PKCE_VERIFIER),
    code_challenge_method: "S256",
  });
  return `/authorize?${params}`;
}

export function consentForm(handle: string, decision = "approve") {
  return {
    method: "POST",
    body: new URLSearchParams({ handle, decision }),
  } satisfies RequestInit;
}

export function handleFrom(html: string) {
  const match = html.match(/name="handle" value="([^"]+)"/);
  if (!match) throw new Error(`No consent handle in: ${html}`);
  return match[1]!;
}

/** Answers GitHub's API as the given user and passes everything else through. */
export function stubGitHub(user: { id: number; login: string } | null) {
  const realFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json(
        user ? { access_token: "gh-token" } : { error: "bad_verification_code" },
      );
    }
    if (url === "https://api.github.com/user") {
      return Response.json(user);
    }
    return realFetch(input, init);
  });
}

/** Walks consent and the GitHub redirect, returning the callback's response. */
export async function signIn(browser: Browser, clientId: string) {
  const page = await browser.fetch(await authorizePath(clientId));
  const handle = handleFrom(await page.text());
  const toGitHub = await browser.fetch("/authorize", consentForm(handle));
  const location = new URL(toGitHub.headers.get("Location")!);
  const state = location.searchParams.get("state")!;
  return browser.fetch(`/callback?code=gh-code&state=${encodeURIComponent(state)}`);
}

export async function exchangeCode(clientId: string, code: string) {
  return send("/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: PKCE_VERIFIER,
    }),
  });
}

/** Runs the whole flow as the allowed user and returns an access token. */
export async function getAccessToken() {
  const spy = stubGitHub(ALLOWED_USER);
  try {
    const clientId = await registerClient();
    const done = await signIn(new Browser(), clientId);
    const code = new URL(done.headers.get("Location")!).searchParams.get("code")!;
    const response = await exchangeCode(clientId, code);
    return ((await response.json()) as { access_token: string }).access_token;
  } finally {
    spy.mockRestore();
  }
}
