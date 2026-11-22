// Cloudflare Pages Functions 미들웨어: VPN·프록시로 접속하면 페이지를 막습니다.
// - 판별: proxycheck.io (환경 변수 PROXYCHECK_KEY가 있으면 하루 1,000회, 없으면 100회 무료)
// - 같은 IP는 1시간 동안 결과를 캐시해 호출 수를 줄입니다.
// - 판별 서비스가 응답하지 않으면 통과시킵니다(장애 때 모든 방문자가 막히는 것 방지).

const BLOCK_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>접속 제한 · Hy2</title><meta name="robots" content="noindex">
<style>:root{--bg:#eef2f6;--card:rgba(255,255,255,.7);--ink:#141a22;--muted:#5a6472;--line:rgba(20,26,34,.1)}
@media (prefers-color-scheme:dark){:root{--bg:#0d1116;--card:rgba(30,37,46,.7);--ink:#eef2f6;--muted:#9aa6b4;--line:rgba(255,255,255,.1)}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.6 Inter,"Noto Sans KR",system-ui,sans-serif;padding:16px}
.c{max-width:420px;padding:32px;border-radius:28px;background:var(--card);border:1px solid var(--line)}
h1{font-size:22px;margin:16px 0 8px;letter-spacing:-.01em}p{margin:0 0 10px;color:var(--muted)}
.b{font-weight:700;font-size:20px}.b sub{font-size:.6em}code{font-size:12px;color:var(--muted)}</style></head>
<body><div class="c"><div class="b">Hy<sub>2</sub></div><h1>VPN을 끄고 다시 접속해 주세요</h1>
<p>보안을 위해 VPN, 프록시, Tor 같은 우회 접속은 막고 있어요.</p>
<p>VPN을 끈 뒤 새로고침하면 바로 들어올 수 있어요. VPN을 쓰지 않는데 이 화면이 보이면 인스타그램 @hy2_k1로 알려 주세요.</p>
<code>IP_PLACEHOLDER</code></div></body></html>`;

async function isVpn(ip, env, ctx) {
  const cache = caches.default;
  const key = new Request(`https://vpn-cache.hy2.internal/${encodeURIComponent(ip)}`);
  const hit = await cache.match(key);
  if (hit) return (await hit.text()) === "1";

  let vpn = false;
  try {
    const q = new URLSearchParams({ vpn: "1", asn: "1" });
    if (env.PROXYCHECK_KEY) q.set("key", env.PROXYCHECK_KEY);
    const r = await fetch(`https://proxycheck.io/v2/${encodeURIComponent(ip)}?${q}`, { signal: AbortSignal.timeout(2500) });
    const body = await r.json();
    const info = body?.[ip];
    if (!info) return false;
    vpn = info.proxy === "yes";
  } catch {
    return false;
  }
  ctx.waitUntil(cache.put(key, new Response(vpn ? "1" : "0", { headers: { "Cache-Control": "max-age=3600" } })));
  return vpn;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  if (request.method !== "GET") return next();

  const url = new URL(request.url);
  const accept = request.headers.get("accept") || "";
  const isPage = accept.includes("text/html") || url.pathname.endsWith(".html") || url.pathname.endsWith("/");
  if (!isPage) return next(); // 이미지·스크립트 요청은 검사하지 않음

  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return next();

  // Tor는 Cloudflare가 국가 코드 T1로 표시
  const torExit = request.cf?.country === "T1";
  if (torExit || (await isVpn(ip, env, context))) {
    return new Response(BLOCK_HTML.replace("IP_PLACEHOLDER", ip.replace(/[^0-9a-fA-F:.]/g, "")), {
      status: 403,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return next();
}
