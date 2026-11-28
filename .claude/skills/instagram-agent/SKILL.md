---
name: instagram-agent
description: Instagram 비즈니스/크리에이터 계정을 Instagram Graph API로 운영하는 에이전트 스킬. 피드 이미지·캐러셀·릴스·스토리 게시, 게시 예약(로컬 큐), 댓글 조회·답글·숨김, 게시물/계정 인사이트 조회를 한다. 사용자가 "인스타에 올려줘", "인스타 예약 게시", "인스타 댓글 답글", "인스타 인사이트/성과 보여줘", Instagram posting/scheduling/comments/insights 를 말하면 사용한다.
---

# Instagram Agent

`scripts/ig.mjs` (Node 18+, 의존성 없음)로 Instagram Graph API를 호출한다. 모든 명령은 JSON을 출력한다.

```bash
node .claude/skills/instagram-agent/scripts/ig.mjs help
```

## 0. 시작 전 점검

1. `IG_ACCESS_TOKEN` 환경변수가 있는지 확인한다. 없으면 [references/setup.md](references/setup.md) 절차를 안내하고 멈춘다. **토큰을 채팅에 붙여 넣게 하지 말고**, 셸 환경변수나 git에 올라가지 않는 `.env`로 넣게 한다. 토큰을 코드·커밋·로그에 절대 남기지 않는다.
2. `whoami` 로 연결된 계정(username, account_type)을 확인하고 사용자에게 계정명을 한 줄로 알린다.
3. 네트워크가 `graph.instagram.com`(또는 `graph.facebook.com`)을 막으면 프록시 오류가 난다. 이때는 환경 네트워크 허용이 필요하다고 알린다.

## 1. 안전 규칙 (반드시 지킨다)

게시·답글·숨김은 공개적으로 되돌리기 어려운 작업이다.

- `publish`, `reply`, `hide` 는 `--confirm` 없이 실행하면 **미리보기(dry run)만** 한다. 먼저 미리보기를 실행해 결과(종류, 캡션 전문, 글자 수, 해시태그 수, 미디어 URL)를 사용자에게 보여준다.
- 사용자가 **이번 게시물에 대해** 명시적으로 승인했을 때만 `--confirm` 을 붙인다. 이전 게시물 승인은 다음 게시물에 적용되지 않는다. "알아서 다 올려" 같은 포괄 승인을 받았다면 그 범위(몇 개, 어떤 내용)를 한 번 확인한다.
- 댓글 답글을 자동으로 여러 개 다는 경우에도 답글 초안 목록을 먼저 보여주고 승인받는다.
- 큐 항목은 `approved: true` 인 것만 `queue run` 에서 게시된다.
- 게시 전 `limit` 로 24시간 게시 한도(quota_usage / config)를 확인한다.

## 2. 미디어 요구사항

Instagram 서버가 미디어를 **직접 내려받으므로** 로컬 파일 경로는 안 된다. 공개 `https` URL이 필요하다.
로컬 파일만 있으면 사용자에게 공개 호스팅 위치(예: 이 저장소의 Cloudflare 정적 자산 `public/`, Supabase Storage 공개 버킷, S3 등)에 올릴지 묻는다. 승인 없이 외부에 업로드하지 않는다.

| 종류 | 형식 | 주요 제한 |
|---|---|---|
| 피드 이미지 | JPEG 권장 | 가로세로비 4:5 ~ 1.91:1, 권장 1080×1350 |
| 캐러셀 | 이미지/영상 혼합 | 2~10장 |
| 릴스 | MP4/MOV (H.264, AAC) | 9:16 권장, 처리에 수 분 걸릴 수 있음 |
| 스토리 | 이미지 또는 영상 | 캡션 미지원, 24시간 후 사라짐 |
| 캡션 | 텍스트 | 최대 2,200자, 해시태그 30개 (스크립트가 검사) |

제한은 Meta 정책 변경으로 바뀔 수 있다. API 오류 메시지가 다르게 말하면 그쪽을 따른다.

## 3. 작업 흐름

### 게시

1. 캡션 작성: 사용자의 브랜드 톤, 목적(홍보/정보/공지), CTA, 해시태그(5~15개 정도 관련성 높은 것)를 반영한다. 긴 캡션은 파일로 저장해 `--caption-file` 로 넘기면 셸 따옴표 문제가 없다.
2. 미리보기:
   ```bash
   node scripts/ig.mjs publish image --image-url https://.../a.jpg --caption-file /tmp/.../caption.txt --alt-text "설명"
   node scripts/ig.mjs publish carousel --items https://.../1.jpg,https://.../2.jpg --caption "..."
   node scripts/ig.mjs publish reel --video-url https://.../v.mp4 --cover-url https://.../c.jpg --caption "..."
   node scripts/ig.mjs publish story --image-url https://.../s.jpg
   ```
3. 사용자 승인 → 같은 명령에 `--confirm` 추가. 스크립트가 컨테이너 생성 → 처리 완료(`status_code=FINISHED`) 대기 → `media_publish` 순서로 진행하고 `permalink` 를 돌려준다. 사용자에게 permalink를 전달한다.

### 예약 게시

Instagram API에는 예약 기능이 없으므로 로컬 큐(`queue.json`, git 제외)로 처리한다.

```bash
node scripts/ig.mjs queue add --kind image --at 2026-12-01T19:00:00+09:00 --image-url https://... --caption "..."   # 승인 전
node scripts/ig.mjs queue approve --id q_xxx     # 사용자 승인 후
node scripts/ig.mjs queue run --dry-run          # 지금 게시될 항목 확인
node scripts/ig.mjs queue run                    # 시간이 된 승인 항목 게시
```

`queue run` 은 시간이 된 항목만 게시하고 항목마다 결과를 저장하므로 중복 게시되지 않는다. 주기 실행은 시스템 cron이나 Claude 예약 작업(사용자가 요청한 경우에만 생성)으로 `queue run` 을 돌린다. 시간은 항상 시간대가 포함된 ISO 형식(한국: `+09:00`)으로 받는다.

### 댓글 관리

```bash
node scripts/ig.mjs media --limit 10                 # 최근 게시물과 댓글 수
node scripts/ig.mjs comments --media-id 1789...      # 댓글 목록
node scripts/ig.mjs reply --comment-id 1790... --message "감사합니다!"   # 미리보기 → 승인 → --confirm
node scripts/ig.mjs hide --comment-id 1790...        # 스팸/악성 댓글 숨김 (--unhide 로 해제)
```

댓글을 분류(질문 / 칭찬 / 불만 / 스팸)해서 보여주고, 질문·불만에는 답글 초안을 제안한다. 개인정보(전화번호, 주소 등)를 답글에 쓰지 않는다. 환불·법적 문제 같은 민감한 건은 사람이 직접 답하도록 표시만 한다.

### 인사이트

```bash
node scripts/ig.mjs insights --media-id 1789...                 # 게시물 성과
node scripts/ig.mjs insights --period day --since 1764514800 --until 1765119600   # 계정 성과
```

결과를 표로 정리하고 의미를 쉽게 설명한다(예: 도달 = 게시물을 본 고유 계정 수). 지표 이름은 API 버전에 따라 바뀐다(예: `impressions` → `views`). "metric ... is not supported" 오류가 나면 `--metric` 으로 지원되는 지표만 다시 요청한다.

## 4. 오류 대응

| 오류 | 원인 | 조치 |
|---|---|---|
| code 190 | 토큰 만료/무효 | setup.md의 토큰 갱신 안내 |
| code 10, 200 | 권한 부족 | 앱 권한(`instagram_business_content_publish` 등) 확인 |
| code 4, 17, 32 | 호출 한도 초과 | 잠시 후 재시도, 반복 호출 줄이기 |
| code 9004 / 2207052 | 미디어를 내려받지 못함 | URL이 공개 https인지, 직접 파일 응답인지 확인 |
| 2207026 등 | 미디어 형식·비율 오류 | 2절 요구사항에 맞게 변환 |
| 컨테이너 `ERROR` | 처리 실패 | `details.status` 메시지 확인 후 미디어 수정 |

오류를 숨기거나 성공한 것처럼 보고하지 않는다. 실패하면 오류 JSON의 핵심을 그대로 전달한다.

## 환경변수

| 이름 | 필수 | 설명 |
|---|---|---|
| `IG_ACCESS_TOKEN` | 예 | 장기 액세스 토큰 |
| `IG_USER_ID` | 아니오 | 없으면 `/me` 로 자동 조회 |
| `IG_GRAPH_HOST` | 아니오 | 기본 `https://graph.instagram.com`. Facebook 로그인 방식 토큰이면 `https://graph.facebook.com` |
| `IG_API_VERSION` | 아니오 | 기본 `v23.0` |
| `IG_QUEUE_FILE` | 아니오 | 예약 큐 파일 위치 |
