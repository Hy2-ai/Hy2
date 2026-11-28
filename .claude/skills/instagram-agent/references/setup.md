# Instagram API 연결 설정

Instagram Graph API는 **프로페셔널 계정(비즈니스 또는 크리에이터)** 만 사용할 수 있다. 개인 계정은 앱 설정 > 계정 유형에서 프로페셔널로 전환한다.

연결 방식은 두 가지다. 새로 시작하면 1번이 간단하다.

## 1. Instagram 로그인 방식 (권장, Facebook 페이지 불필요)

1. https://developers.facebook.com 에서 앱 생성 → 사용 사례에서 **Instagram API** 추가.
2. "Instagram 로그인으로 API 설정"에서 사용할 Instagram 계정을 추가하고 토큰을 생성한다.
3. 필요한 권한:
   - `instagram_business_basic` — 계정·게시물 조회
   - `instagram_business_content_publish` — 게시
   - `instagram_business_manage_comments` — 댓글 조회·답글·숨김
   - `instagram_business_manage_insights` — 인사이트
4. 발급된 토큰은 장기 토큰(약 60일)이어야 한다. 단기 토큰이면 앱 시크릿으로 교환한다:
   `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=...&access_token=...`
5. 만료 전 갱신(발급 24시간 이후, 만료 전 언제든):
   `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=...`

호스트: `https://graph.instagram.com` (스크립트 기본값)

## 2. Facebook 로그인 방식 (Facebook 페이지에 연결된 계정)

권한: `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`.
페이지에 연결된 IG 계정 ID는 `GET /{page-id}?fields=instagram_business_account` 로 얻는다.

이 방식이면 `IG_GRAPH_HOST=https://graph.facebook.com` 과 `IG_USER_ID` 를 설정한다.

## 토큰 넣기 (안전하게)

토큰은 비밀번호와 같다. 채팅·코드·커밋에 넣지 않는다.

```bash
# 저장소 루트의 .env (이미 .gitignore 에 포함됨)
IG_ACCESS_TOKEN=...
# IG_GRAPH_HOST=https://graph.facebook.com
# IG_USER_ID=1784...
```

```bash
set -a; source .env; set +a
node .claude/skills/instagram-agent/scripts/ig.mjs whoami
```

Claude Code 클라우드 세션에서는 환경 설정의 네트워크 시크릿 기능으로 `graph.instagram.com` 호스트에 `Authorization: Bearer` 헤더를 주입할 수 있다. 이 경우 `IG_ACCESS_TOKEN` 에는 아무 더미 값을 넣어도 프록시가 실제 토큰으로 바꿔 보낸다.

## 앱 검수

본인 계정만 쓰는 경우 개발 모드(앱 역할에 본인 추가)로 충분하다. 다른 사람의 계정을 연결하려면 Meta 앱 검수가 필요하다.
