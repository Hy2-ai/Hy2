// Hy2 Worker: 모든 요청을 먼저 받아 VPN·프록시·Tor 접속을 막고, 통과하면 public/ 폴더의 파일을 보여 줍니다.
import { blockIfVpn } from "./vpn.js";

export default {
  async fetch(request, env, ctx) {
    const blocked = await blockIfVpn(request, env, ctx);
    if (blocked) return blocked;

    // 주소 정리: / → index.html (페이지 주소는 .html 그대로 사용)
    const url = new URL(request.url);
    if (url.pathname === "/") {
      url.pathname = "/index.html";
      return env.ASSETS.fetch(new Request(url, request));
    }
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404) {
      return new Response("페이지를 찾을 수 없어요.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return res;
  },
};
