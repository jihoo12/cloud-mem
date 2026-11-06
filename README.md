# cloud-mem

**English** | [한국어](README.ko.md)

A long-term memory MCP server for Claude. It runs on Cloudflare Workers and D1 in your own account, so work logs and memories saved by Claude on one device can be searched by Claude on any other.

You sign in with GitHub instead of copying tokens around, and only the one account you choose can get in.

## Tools

| Tool | What it does |
| --- | --- |
| `memory_save` | Saves an entry. `kind` is `worklog` (work done) or `memory` (lasting facts, preferences and decisions) |
| `memory_search` | Searches entries, or lists recent ones when `query` is omitted. Filters by `kind`, `project`, `tag` and `since` |
| `memory_get` | Gets the full text of an entry |
| `memory_update` | Changes an entry |
| `memory_delete` | Permanently deletes an entry |

Search matches substrings and ignores case. All space-separated terms must match. Substring matching also makes it work for Korean, where particles attach directly to words: `메모리` finds `메모리를`.

## Deploy

You need a Cloudflare account, a GitHub account and Node.js 24. If you use Nix, `nix develop` provides Node.js and wrangler, and you can replace `npx wrangler` below with `wrangler`.

**1. Install and create your config**

```sh
git clone https://github.com/jihoo12/cloud-mem.git
cd cloud-mem
npm install
npx wrangler login
cp wrangler.example.jsonc wrangler.jsonc
```

Fill in `PUBLIC_ORIGIN` and `GITHUB_ALLOWED_USER_ID` in `wrangler.jsonc`. Git ignores this file.

- `PUBLIC_ORIGIN`: `https://cloud-mem.<your-workers-subdomain>.workers.dev`
- `GITHUB_ALLOWED_USER_ID`: the number from `curl -s https://api.github.com/users/<your-login> | grep '"id"' | head -1`

**2. Deploy**

The D1 database and KV namespace are created on the first deploy.

```sh
npx wrangler deploy
npx wrangler d1 migrations apply cloud-mem --remote
```

**3. Create a GitHub OAuth App**

[Create a new app](https://github.com/settings/applications/new). Use your `PUBLIC_ORIGIN` as the homepage URL and `<PUBLIC_ORIGIN>/callback` as the authorization callback URL. Then generate a client secret and add both values:

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Until these are set, the sign-in page returns 503 and `/mcp` rejects every unauthenticated request with 401.

## Connect Claude Code

Run this once on each device. `X-Device` records which device saved each entry.

```sh
claude mcp add --scope user --transport http cloud-mem \
  https://cloud-mem.<your-workers-subdomain>.workers.dev/mcp \
  --header "X-Device: $(hostname)"
```

Then open `/mcp` in Claude Code and authenticate `cloud-mem`. GitHub sign-in opens in your browser.

The server sends Claude usage instructions when it connects. To make Claude use it more reliably, also add this to `~/.claude/CLAUDE.md`:

```markdown
When starting a task, use cloud-mem's memory_search to find related records. After finishing meaningful work, record it with memory_save.
```

## Security

- **Allowed account:** Only the GitHub account whose numeric id matches `GITHUB_ALLOWED_USER_ID` gets in. Logins aren't compared, because they can be renamed.
- **Consent page:** Every sign-in shows which app is receiving access. The flow is bound to your browser, so a link made by someone else can't complete a sign-in.
- **Scope of access:** An authenticated client can read and delete every entry. Don't store passwords or API keys.
- **Prompt injection:** Saved text is later read by Claude. If malicious text ends up in an entry, for example while Claude works with an untrusted web page, it can affect other sessions. The server tells Claude that entries aren't instructions from you, but that isn't a complete defense.

## Limitations

- **One user:** Entries aren't separated by user. Each person needs their own deployment.
- **Not automatic:** Claude decides when to call the tools, so it can miss things.
- **No semantic search:** The characters have to match. Searching for "login" won't find "authentication".
- **Browser required:** Signing in is awkward on a machine you only reach over SSH.
- **Deletes are permanent:** `memory_delete` can't be undone. To recover data, use D1 Time Travel.

## Development

```sh
nix develop   # Required on NixOS, where the workerd binary from npm won't run
npm install
npm test
npm run typecheck
```

Tests use `wrangler.example.jsonc`, so they don't need a `wrangler.jsonc`.

To try sign-in locally, create a separate GitHub OAuth App with the callback URL `http://localhost:8787/callback`. Put `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `PUBLIC_ORIGIN=http://localhost:8787` in `.dev.vars`, then run:

```sh
npx wrangler d1 migrations apply cloud-mem --local
npx wrangler dev
```

## License

[Apache 2.0](LICENSE)
