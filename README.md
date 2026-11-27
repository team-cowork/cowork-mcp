# cowork-mcp

Claude Code 또는 Codex CLI에서 cowork 팀·채널·스레드를 이름으로 찾아 최근 메시지를 읽고, 사용자가 확인한 작업 보고를 스레드에 남깁니다. Node.js 22.13 이상이 필요합니다.

**모델에 전달되는 데이터**
검색 결과의 팀·채널·스레드 이름과 읽은 스레드의 메시지 본문은 MCP 클라이언트가 사용하는 모델 제공자에게 전달됩니다. 연결 전에 해당 정보를 모델 제공자에게 전달해도 되는지 확인하세요.

## cowork 에이전트 토큰 발급과 폐기

서버에 에이전트 토큰 API가 배포된 후, cowork에 로그인한 사용자 권한으로 다음 Gateway API를 사용합니다. 이 경로에서 `Authorization: Bearer <로그인 access JWT>`를 사용합니다. JWT와 발급된 토큰은 비밀번호처럼 보관하세요.

| 작업 | 요청 |
| --- | --- |
| 발급 | `POST /api/authorization/auth/agent-tokens` |
| 내 토큰과 ID 조회 | `GET /api/authorization/auth/agent-tokens` |
| 폐기 | `DELETE /api/authorization/auth/agent-tokens/{id}` |

발급 시 `Content-Type: application/json` 헤더와 아래 본문을 보냅니다. 조회만 필요하면 `chat:write`를 생략하세요. 응답의 `data.token`은 발급 시 한 번만 표시됩니다. 폐기 후에는 클라이언트 환경에서도 해당 값을 삭제하세요.

```json
{
  "name": "cowork-mcp",
  "scopes": ["workspace:read", "chat:read", "chat:write"],
  "expires_in_days": 30
}
```

## MCP 등록

클라이언트를 실행하는 환경에 다음 값을 설정합니다. 토큰은 로컬 환경이나 비밀 저장소에서 주입하고 공유 설정에 저장하지 마세요.

- `COWORK_API_URL`은 cowork API Gateway의 HTTPS 주소입니다. 예시는 `https://cowork.example`입니다.
- `COWORK_AGENT_TOKEN`은 위에서 발급한 에이전트 토큰입니다.

npm 패키지 이름은 확정 전입니다. 현재 소스에서 빌드하고 아래 설정의 경로를 자신의 체크아웃에 맞게 바꾸면 두 클라이언트에 등록할 수 있습니다.

```sh
npm ci
npm run build
```

### Claude Code

토큰 값을 환경 변수에서 가져오려면 프로젝트의 `.mcp.json`에 아래 stdio 서버를 추가하세요. `${...}`는 Claude Code가 실행할 때 확장합니다. `claude mcp list`로 등록을 확인합니다.

```json
{
  "mcpServers": {
    "cowork-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/cowork-mcp/dist/index.js"],
      "env": {
        "COWORK_API_URL": "${COWORK_API_URL}",
        "COWORK_AGENT_TOKEN": "${COWORK_AGENT_TOKEN}"
      }
    }
  }
}
```

[Claude Code MCP 설정](https://code.claude.com/docs/en/mcp)

### Codex CLI

`~/.codex/config.toml`에 추가하세요. `env_vars`는 Codex를 실행한 환경에서 값을 전달합니다. `codex mcp list`로 등록을 확인합니다.

```toml
[mcp_servers.cowork-mcp]
command = "node"
args = ["/absolute/path/to/cowork-mcp/dist/index.js"]
env_vars = ["COWORK_API_URL", "COWORK_AGENT_TOKEN"]
```

[Codex MCP 설정](https://developers.openai.com/codex/mcp)

npm에 게시된 후에는 위 두 설정에서 실행 명령을 `npx`, 인수를 `["--yes", "<확정된 npm 패키지 이름>"]`으로 바꿀 수 있습니다. Windows에서 `npx` 실행에 셸이 필요하면 명령을 `cmd.exe`, 인수를 `["/c", "npx", "--yes", "<확정된 npm 패키지 이름>"]`으로 설정하세요.

## 사용 흐름

[작업 흐름 스킬](skills/cowork-thread/SKILL.md) 디렉터리를 Claude Code의 `.claude/skills/` 또는 Codex의 `.agents/skills/` 아래에 복사합니다. 예를 들어 “backend 채널의 로그인 버그 스레드를 찾아 읽고, 이번 수정 결과를 보고할 초안을 작성해 줘”라고 요청할 수 있습니다.

| 도구 | 필요한 scope | 결과 |
| --- | --- | --- |
| `list_teams_and_channels` | `workspace:read` | 팀과 채널 이름 및 ID |
| `list_threads` | `workspace:read` | 채널의 스레드와 다음 페이지 |
| `read_thread` | `chat:read` | 스레드의 최근 텍스트 메시지와 이전 페이지 커서 |
| `post_thread_message` | `chat:write` | 확인받은 보고의 접수 상태와 `clientMessageId` |

게시 전에 대상과 초안을 확인하세요. 접수 후 실제 게시 여부는 스레드를 읽어 확인할 수 있습니다. 동일한 게시를 도구에서 다시 시도할 때는 앞선 결과의 `clientMessageId`를 사용하세요.

## 개발 및 배포

```sh
npm ci
npm run lint
npm test
npm pack --dry-run
```

테스트는 모의 HTTP 응답을 사용합니다. 실제 cowork 연동 검증은 서버 배포 후 진행합니다.

npm 이름을 확정하면 `package.json`과 잠금 파일의 이름을 맞추고 GitHub 저장소 변수 `NPM_PACKAGE_NAME`에 그 이름을 설정합니다. npm에서 `team-cowork/cowork-mcp`의 `publish.yml`을 Trusted Publisher로 설정하고 직접 게시를 허용합니다. 최초 게시에 Trusted Publisher를 구성할 수 없는 경우에는 게시 권한이 있는 npm 토큰을 GitHub의 `NPM_TOKEN` 시크릿에 설정해 첫 태그를 배포한 뒤 Trusted Publisher로 전환하세요. 버전과 일치하는 `v<version>` 태그를 push하면 검사 후 게시합니다.

[npm Trusted Publishing 설정](https://docs.npmjs.com/trusted-publishers/)
