# cloud-mem

Claude용 장기기억 MCP 서버입니다. Cloudflare Workers와 D1 위에서 돌아가므로, 한 기기의 Claude가 올린 작업 기록과 메모리를 다른 기기의 Claude가 바로 검색해 쓸 수 있습니다.

## 도구

| 도구 | 설명 |
| --- | --- |
| `memory_save` | 항목 저장. `kind`는 `worklog`(작업 기록) 또는 `memory`(오래 유지할 사실, 선호, 결정) |
| `memory_search` | 검색. `query`를 생략하면 최근 항목 목록. `kind`, `project`, `tag`, `since`로 필터링 |
| `memory_get` | 항목 전문 조회 |
| `memory_update` | 항목 수정 |
| `memory_delete` | 항목 영구 삭제 |

검색은 부분 문자열 매칭이고 대소문자를 구분하지 않습니다. 그래서 `메모리`로 "메모리를"을 찾을 수 있습니다. 공백으로 나눈 검색어는 모두 일치해야 합니다.

## 개발 환경

Node.js와 wrangler는 Nix flake로 제공합니다. 이후 명령은 모두 `nix develop` 셸 안에서 실행합니다.

```sh
nix develop
npm install
npm test
npm run typecheck
```

`npx wrangler`나 npm 스크립트 대신 `wrangler`를 직접 실행하세요. 그래야 테스트 플러그인이 함께 설치한 wrangler가 아니라 Nix의 wrangler가 쓰입니다.

로컬에서 로그인까지 시험하려면 콜백 URL이 `http://localhost:8787/callback`인 GitHub OAuth App을 따로 만들고, `.dev.vars`에 `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`과 `PUBLIC_ORIGIN=http://localhost:8787`을 넣은 뒤 다음을 실행합니다.

```sh
wrangler d1 migrations apply cloud-mem --local
wrangler dev
```

## 배포

`wrangler.jsonc`의 `PUBLIC_ORIGIN`과 `GITHUB_ALLOWED_USER_ID`를 자신의 값으로 맞춥니다. 숫자 ID는 `https://api.github.com/users/<사용자명>`에서 확인할 수 있습니다.

[GitHub OAuth App](https://github.com/settings/applications/new)을 만들 때 콜백 URL은 `<PUBLIC_ORIGIN>/callback`으로 입력합니다. 그다음 아래 명령을 실행합니다.

```sh
wrangler login
wrangler deploy                                   # 처음 배포할 때 D1과 KV도 생성
wrangler d1 migrations apply cloud-mem --remote
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
```

시크릿을 설정하기 전까지는 로그인 페이지가 503을 반환하고, `/mcp`는 토큰 없는 요청을 모두 401로 거부합니다.

## 인증

GitHub OAuth로 로그인하며, `GITHUB_ALLOWED_USER_ID`와 숫자 ID가 일치하는 계정만 통과합니다. 로그인할 때마다 어떤 앱이 권한을 받는지 보여 주는 동의 화면을 거칩니다.

## Claude Code에 연결

기기마다 한 번씩 실행합니다. `X-Device` 값은 저장되는 항목에 어느 기기에서 올렸는지 기록하는 데 쓰입니다.

```sh
claude mcp add --scope user --transport http cloud-mem \
  https://cloud-mem.jihoo12.workers.dev/mcp \
  --header "X-Device: $(hostname)"
```

그다음 Claude Code에서 `/mcp`를 열어 `cloud-mem`을 인증하면 브라우저에서 GitHub 로그인이 진행됩니다.

서버가 Claude에게 사용 지침을 함께 보내지만, 더 확실하게 쓰게 하려면 `~/.claude/CLAUDE.md`에 다음을 추가하세요.

```markdown
작업을 시작할 때 cloud-mem의 memory_search로 관련 기록을 찾고, 의미 있는 작업을 마치면 memory_save로 기록을 남긴다.
```

## 제한 사항

- 로그인에 브라우저가 필요해서, SSH로만 접속하는 기기에서는 인증이 번거롭습니다.
- 인증된 클라이언트는 모든 항목을 읽고 지울 수 있습니다. 비밀번호나 API 키는 저장하지 마세요.
- `memory_delete`는 복구할 수 없습니다. 복구가 필요하면 D1의 Time Travel 기능을 사용하세요.
