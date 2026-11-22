# Hy2

Hy2 1인 스튜디오 홈페이지: 소개, 서비스, 후기, 코인 후원, 회원제 1:1 문의, 관리자 페이지.

## 구조

| 위치 | 역할 |
| --- | --- |
| `public/` | 정적 웹사이트 (Cloudflare Pages가 배포하는 폴더) |
| `functions/_middleware.js` | Cloudflare Pages Functions: VPN·프록시·Tor 접속 차단 |
| `supabase/migrations/` | DB 테이블, 보안 정책(RLS), 자동 삭제 작업 |
| `supabase/functions/auth` | 가입·로그인 (VPN 검사, IP·기기 기록, 로그인 실패 제한) |
| `supabase/functions/admin` | 어드민 전용: 비밀번호·이름·이메일 재설정, OTP 초기화, 이용 제한 |

- 데이터베이스·인증: Supabase 프로젝트 `hy2` (서울 리전, `qoyngutpzhutpimjgbtz`)
- 로그인 유지: 7일 (DB가 매시간 7일 지난 세션을 삭제하고, 모든 데이터 접근 시 세션 나이를 확인)
- 로그인 IP·기기 기록: 3개월 뒤 매일 새벽 자동 삭제
- OTP: Supabase Auth TOTP (Google Authenticator 등)
- 후기: 문의가 종료된 회원만 작성, 최신 10개만 남고 나머지는 자동 삭제
- 비밀번호는 해시로 저장되어 어드민도 볼 수 없고, 재설정만 가능

## Cloudflare Pages 연결

1. Cloudflare 대시보드 → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. 이 저장소(`Hy2-ai/hy2-site`) 선택
3. 빌드 설정
   - Framework preset: `None`
   - Build command: (비워 두기)
   - Build output directory: `public`
4. **Settings → Variables and Secrets**에 `PROXYCHECK_KEY` 추가 (Secret 유형)
5. 저장 후 배포 → `https://<프로젝트명>.pages.dev` 로 접속

## proxycheck.io 키

1. https://proxycheck.io 가입 → 대시보드에서 API 키 복사 (무료 하루 1,000회)
2. 두 곳에 같은 키를 넣습니다.
   - Cloudflare Pages: 위 4번 (`PROXYCHECK_KEY`)
   - Supabase: Dashboard → Edge Functions → **Secrets** → `PROXYCHECK_KEY`
3. 키가 없어도 하루 100회까지는 동작합니다. 판별 서비스가 응답하지 않으면 접속을 막지 않고 통과시킵니다.

## 어드민 계정 만들기

사이트의 회원가입에서 아래처럼 가입하면 자동으로 어드민이 됩니다. 다른 이메일로는 `Hy2` 아이디를 쓸 수 없습니다.

- 아이디: `Hy2`
- 이메일: `hayul120205@outlook.kr`
- 비밀번호: 직접 정한 비밀번호

가입 후 **내 계정 · 보안**에서 OTP를 켜 두세요.

## Supabase 설정 권장

- Authentication → Sign In / Providers → **Allow new users to sign up** 끄기
  (가입은 Edge Function이 서버 권한으로 처리하므로 꺼도 가입이 됩니다. 켜져 있어도 DB 트리거가 우회 가입을 막습니다.)
- Authentication → URL Configuration → Site URL을 실제 도메인으로 변경
