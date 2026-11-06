# cloud-mem

[English](README.md) | **한국어**

Claude Code와 Codex용 장기기억 MCP 서버입니다. 내 Cloudflare 계정의 Workers와 D1 위에서 돌아가므로, 한 기기에서 올린 작업 기록과 메모리를 다른 기기에서 어느 쪽 에이전트로든 바로 검색해 쓸 수 있습니다.

토큰을 복사할 필요 없이 GitHub로 로그인하고, 지정한 계정 하나만 접근할 수 있습니다.

## 도구

| 도구 | 설명 |
| --- | --- |
| `memory_save` | 항목 저장. `kind`는 `worklog`(작업 기록) 또는 `memory`(오래 유지할 사실, 선호, 결정) |
| `memory_search` | 검색. `query`를 생략하면 최근 항목 목록. `kind`, `project`, `tag`, `since`로 필터링 |
| `memory_get` | 항목 전문 조회 |
| `memory_update` | 항목 수정 |
| `memory_delete` | 항목 영구 삭제 |

검색은 부분 문자열 매칭이고 대소문자를 구분하지 않습니다. 그래서 `메모리`로 "메모리를"을 찾을 수 있습니다. 공백으로 나눈 검색어는 모두 일치해야 합니다.

## 배포

Cloudflare 계정과 GitHub 계정, Node.js 24가 필요합니다. Nix를 쓴다면 `nix develop`으로 Node.js와 wrangler를 받고 아래의 `npx wrangler`를 `wrangler`로 바꿔 실행하세요.

**1. 설치하고 설정 파일 만들기**

```sh
git clone https://github.com/jihoo12/cloud-mem.git
cd cloud-mem
npm install
npx wrangler login
cp wrangler.example.jsonc wrangler.jsonc
```

`wrangler.jsonc`의 `PUBLIC_ORIGIN`과 `GITHUB_ALLOWED_USER_ID`를 채웁니다. 이 파일은 git에 포함되지 않습니다.

- `PUBLIC_ORIGIN`: `https://cloud-mem.<내 workers.dev 서브도메인>.workers.dev`
- `GITHUB_ALLOWED_USER_ID`: `curl -s https://api.github.com/users/<사용자명> | grep '"id"' | head -1`로 확인한 숫자

**2. 배포하기**

D1 데이터베이스와 KV 네임스페이스는 첫 배포 때 자동으로 만들어집니다.

```sh
npx wrangler deploy
npx wrangler d1 migrations apply cloud-mem --remote
```

**3. GitHub OAuth App 만들기**

[여기서 새 앱을 만듭니다](https://github.com/settings/applications/new). Homepage URL에는 `PUBLIC_ORIGIN`을, Authorization callback URL에는 `<PUBLIC_ORIGIN>/callback`을 입력합니다. 그런 다음 Client ID와 새로 발급한 Client Secret을 넣습니다.

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

시크릿을 넣기 전까지는 로그인 페이지가 503을 반환하고, `/mcp`는 인증 없는 요청을 모두 401로 거부합니다.

## Claude Code에 연결

기기마다 한 번씩 실행합니다. `X-Device` 값은 각 항목을 어느 기기에서 올렸는지 기록하는 데 쓰입니다.

```sh
claude mcp add --scope user --transport http cloud-mem \
  https://cloud-mem.<내 서브도메인>.workers.dev/mcp \
  --header "X-Device: $(hostname)"
```

그다음 Claude Code에서 `/mcp`를 열어 `cloud-mem`을 인증하면 브라우저에서 GitHub 로그인이 진행됩니다.

서버가 Claude에게 사용 지침을 함께 보내지만, 더 확실하게 쓰게 하려면 `~/.claude/CLAUDE.md`에 다음을 추가하세요.

```markdown
작업을 시작할 때 cloud-mem의 memory_search로 관련 기록을 찾고, 의미 있는 작업을 마치면 memory_save로 기록을 남긴다.
```

## Codex에 연결

기기마다 한 번씩 실행합니다. 로그인이 자동으로 시작되지 않으면 `codex mcp login cloud-mem`을 실행하세요.

```sh
codex mcp add cloud-mem --url https://cloud-mem.<내 서브도메인>.workers.dev/mcp
```

기기 이름을 기록하려면 `~/.codex/config.toml`의 `[mcp_servers.cloud-mem]` 아래에 다음 줄을 추가합니다.

```toml
http_headers = { "X-Device" = "my-laptop" }
```

Codex는 `memory_save`처럼 데이터를 바꾸는 도구를 쓰기 전에 승인을 요청합니다. 그래서 비대화형인 `codex exec`에서는 해당 도구의 승인을 따로 설정하지 않으면 검색만 되고 저장은 되지 않습니다. 더 확실하게 쓰게 하려면 위의 `CLAUDE.md` 문장을 `~/.codex/AGENTS.md`에도 추가하세요.

## 보안

- **허용 계정:** `GITHUB_ALLOWED_USER_ID`와 숫자 ID가 일치하는 GitHub 계정만 통과합니다. 사용자명은 바뀔 수 있어서 비교에 쓰지 않습니다.
- **동의 화면:** 로그인할 때마다 어떤 앱이 권한을 받는지 보여 줍니다. 흐름은 브라우저에 묶여 있어서, 다른 사람이 만든 링크로는 로그인을 완료할 수 없습니다.
- **접근 범위:** 인증된 클라이언트는 모든 항목을 읽고 지울 수 있습니다. 비밀번호나 API 키는 저장하지 마세요.
- **프롬프트 인젝션:** 저장된 내용은 나중에 Claude에게 그대로 읽힙니다. 신뢰할 수 없는 웹페이지 등을 다루다 악의적인 문구가 기록에 섞이면 다른 세션에 영향을 줄 수 있습니다. 서버는 항목을 사용자의 지시로 취급하지 말라고 안내하지만, 이것으로 완전히 막을 수는 없습니다.

## 제한 사항

- **사용자 한 명 전용:** 항목을 사용자별로 나누지 않습니다. 여러 명이 쓰려면 각자 따로 배포해야 합니다.
- **자동 저장 아님:** 에이전트가 스스로 도구를 호출하므로 빠뜨릴 수 있습니다.
- **의미 검색 없음:** 글자가 일치해야 찾습니다. "로그인"으로 "인증"을 찾지는 못합니다.
- **브라우저 필요:** SSH로만 접속하는 기기에서는 로그인이 번거롭습니다.
- **복구 불가 삭제:** `memory_delete`는 되돌릴 수 없습니다. 복구가 필요하면 D1의 Time Travel 기능을 사용하세요.

## 개발

```sh
nix develop   # NixOS에서는 필수입니다. npm이 받는 workerd가 실행되지 않기 때문입니다.
npm install
npm test
npm run typecheck
```

테스트는 `wrangler.example.jsonc`로 돌아가므로 `wrangler.jsonc`가 없어도 됩니다.

로컬에서 로그인까지 시험하려면 콜백 URL이 `http://localhost:8787/callback`인 GitHub OAuth App을 따로 만들고, `.dev.vars`에 `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `PUBLIC_ORIGIN=http://localhost:8787`을 넣은 뒤 다음을 실행합니다.

```sh
npx wrangler d1 migrations apply cloud-mem --local
npx wrangler dev
```

## 라이선스

[Apache 2.0](LICENSE)
