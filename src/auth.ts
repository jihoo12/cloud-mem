import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
} from "@cloudflare/workers-oauth-provider";
import type {
  ConsentDescription,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

export interface AuthEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_ALLOWED_USER_ID?: string;
}

interface GitHubUser {
  id: number;
  login: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function htmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  button { font: inherit; padding: .5rem 1rem; margin-right: .5rem; }
  .warning { border-left: 4px solid #d97706; padding-left: .75rem; }
</style>
<h1>${escapeHtml(title)}</h1>
${body}
</html>`;
}

function messagePage(status: number, title: string, message: string): Response {
  return new Response(htmlDocument(title, `<p>${escapeHtml(message)}</p>`), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const verified = details.clientDomain
    ? `<p>게시자: <strong>${escapeHtml(details.clientDomain)}</strong></p>`
    : "<p>이 앱은 스스로 등록했기 때문에 이름이 검증되지 않았습니다.</p>";
  const loopback = details.redirectIsLoopback
    ? '<p class="warning">이 컴퓨터에서 실행 중인 앱으로 권한이 전달됩니다. 방금 직접 로그인을 시작한 경우에만 계속하세요.</p>'
    : "";
  return htmlDocument(
    "cloud-mem 접근 허용",
    `<p><strong>${name}</strong>이(가) 장기기억 항목을 읽고, 쓰고, 지울 수 있게 됩니다.</p>
${verified}
<p>권한이 전달되는 곳: <strong>${escapeHtml(details.redirectHost)}</strong></p>
${loopback}
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <button name="decision" value="approve">GitHub로 계속</button>
  <button name="decision" value="deny">거부</button>
</form>`,
  );
}

async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function callbackUrl(request: Request): string {
  return new URL("/callback", request.url).href;
}

async function showConsent(request: Request, env: AuthEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(consentPage(details, consent.handle), {
    headers: consent.headers,
  });
}

async function submitConsent(
  request: Request,
  env: AuthEnv,
  clientId: string,
): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle"));

  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const approved = await oauth.approveConsent(request, handle);
  const verifier = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });

  const github = new URL("https://github.com/login/oauth/authorize");
  github.searchParams.set("client_id", clientId);
  github.searchParams.set("redirect_uri", callbackUrl(request));
  github.searchParams.set("state", state);
  github.searchParams.set("code_challenge", await sha256Base64Url(verifier));
  github.searchParams.set("code_challenge_method", "S256");
  headers.set("Location", github.href);
  return new Response(null, { status: 302, headers });
}

/** Returns null when GitHub doesn't confirm a user for this code. */
async function fetchGitHubUser(
  request: Request,
  env: AuthEnv,
  code: string,
  verifier: string,
): Promise<GitHubUser | null> {
  const tokenResponse = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID!,
        client_secret: env.GITHUB_CLIENT_SECRET!,
        code,
        code_verifier: verifier,
        redirect_uri: callbackUrl(request),
      }),
    },
  );
  if (!tokenResponse.ok) return null;
  const { access_token: accessToken } = (await tokenResponse.json()) as {
    access_token?: string;
  };
  if (!accessToken) return null;

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cloud-mem",
    },
  });
  return userResponse.ok ? ((await userResponse.json()) as GitHubUser) : null;
}

async function handleCallback(
  request: Request,
  env: AuthEnv,
  allowedUserId: string,
): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  // Runs first: it rejects a state that isn't bound to this browser, before
  // anything is sent to GitHub.
  const {
    request: original,
    data,
    headers,
  } = await oauth.finishUpstream<{ verifier: string }>(request);

  const deny = (description?: string) => {
    headers.set(
      "Location",
      authorizationErrorRedirect(original, "access_denied", description),
    );
    return new Response(null, { status: 302, headers });
  };

  const code = new URL(request.url).searchParams.get("code");
  if (!code) return deny();

  const user = await fetchGitHubUser(request, env, code, data.verifier);
  if (!user) {
    return messagePage(
      502,
      "GitHub 로그인 실패",
      "GitHub에서 계정을 확인하지 못했습니다. 다시 시도해 주세요.",
    );
  }
  // Compare the numeric id: a login can be renamed and then claimed by someone else.
  if (String(user.id) !== allowedUserId) {
    console.warn(`Rejected GitHub user ${user.login} (${user.id})`);
    return deny("This GitHub account is not allowed");
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: String(user.id),
    metadata: { login: user.login },
    scope: original.scope,
    props: { githubId: user.id, login: user.login },
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

export const authHandler = {
  async fetch(request: Request, env: AuthEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    const isAuthorize = pathname === "/authorize";
    if (!isAuthorize && pathname !== "/callback") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_ALLOWED_USER_ID } = env;
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET || !GITHUB_ALLOWED_USER_ID) {
      return messagePage(
        503,
        "설정 필요",
        "서버에 GitHub 로그인이 아직 설정되지 않았습니다.",
      );
    }

    try {
      if (isAuthorize && request.method === "GET") {
        return await showConsent(request, env);
      }
      if (isAuthorize && request.method === "POST") {
        return await submitConsent(request, env, GITHUB_CLIENT_ID);
      }
      if (!isAuthorize && request.method === "GET") {
        return await handleCallback(request, env, GITHUB_ALLOWED_USER_ID);
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) {
        return Response.redirect(error.redirectTo, 302);
      }
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const detail =
          error instanceof AuthorizationError ? error.description : "앱을 확인할 수 없습니다.";
        return messagePage(
          400,
          "인증을 진행할 수 없습니다",
          `${detail} Claude에서 로그인을 다시 시작해 주세요.`,
        );
      }
      throw error;
    }
  },
};
