// Hy2 auth: 가입/로그인을 서버에서 처리합니다.
// - VPN·프록시 접속 차단 (proxycheck.io, 결과 1일 캐시)
// - IP 기준 로그인 실패 제한 (15분 10회)
// - 로그인 IP·기기·브라우저 기록 (DB 크론이 3개월 후 삭제)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PROXYCHECK_KEY = Deno.env.get("PROXYCHECK_KEY") ?? "";

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (status: number, code: string, message: string) => json(status, { error: code, message });

function clientIp(req: Request): string {
  const h = req.headers;
  const xff = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return h.get("cf-connecting-ip") ?? h.get("x-real-ip") ?? xff ?? "unknown";
}

export function parseUA(ua: string) {
  const s = ua || "";
  const device = /iPad|Tablet/i.test(s) ? "태블릿" : /Mobi|iPhone|Android/i.test(s) ? "모바일" : "데스크톱";
  const os = /Windows NT/i.test(s) ? "Windows"
    : /iPhone|iPad|iPod/i.test(s) ? "iOS"
    : /Mac OS X/i.test(s) ? "macOS"
    : /Android/i.test(s) ? "Android"
    : /CrOS/i.test(s) ? "ChromeOS"
    : /Linux/i.test(s) ? "Linux" : "기타";
  const browser = /KAKAOTALK/i.test(s) ? "카카오톡"
    : /Whale/i.test(s) ? "Whale"
    : /SamsungBrowser/i.test(s) ? "Samsung Internet"
    : /Edg\//i.test(s) ? "Edge"
    : /OPR\//i.test(s) ? "Opera"
    : /Firefox|FxiOS/i.test(s) ? "Firefox"
    : /Chrome|CriOS/i.test(s) ? "Chrome"
    : /Safari/i.test(s) ? "Safari" : "기타";
  return { device, os, browser };
}

type VpnResult = { isVpn: boolean | null; country: string | null };

async function checkVpn(ip: string): Promise<VpnResult> {
  if (ip === "unknown") return { isVpn: null, country: null };
  const { data: cached } = await admin.from("vpn_cache").select("is_vpn, detail").eq("ip", ip).maybeSingle();
  if (cached) return { isVpn: cached.is_vpn, country: cached.detail };
  try {
    const q = new URLSearchParams({ vpn: "1", asn: "1" });
    if (PROXYCHECK_KEY) q.set("key", PROXYCHECK_KEY);
    const r = await fetch(`https://proxycheck.io/v2/${encodeURIComponent(ip)}?${q}`, { signal: AbortSignal.timeout(3000) });
    const body = await r.json();
    const info = body?.[ip];
    if (!info) return { isVpn: null, country: null }; // 조회 실패 시 통과 (서비스 장애로 모두 막히는 것 방지)
    const isVpn = info.proxy === "yes";
    const country = info.isocode ?? null;
    await admin.from("vpn_cache").upsert({ ip, is_vpn: isVpn, detail: country, checked_at: new Date().toISOString() });
    return { isVpn, country };
  } catch {
    return { isVpn: null, country: null };
  }
}

function sessionIdFrom(token: string): string | null {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part)).session_id ?? null;
  } catch {
    return null;
  }
}

async function tooManyFailures(ip: string) {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { count } = await admin.from("auth_attempts").select("id", { count: "exact", head: true })
    .eq("ip", ip).eq("success", false).gte("created_at", since);
  return (count ?? 0) >= 10;
}

async function signInAndLog(email: string, password: string, ip: string, ua: string, vpn: VpnResult) {
  const anon = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data.session) return { error: true as const };
  const { data: prof } = await admin.from("profiles").select("is_banned").eq("id", data.user.id).maybeSingle();
  if (!prof || prof.is_banned) {
    await admin.rpc("revoke_user_sessions", { p_user: data.user.id });
    return { banned: true as const };
  }
  const sid = sessionIdFrom(data.session.access_token);
  const { device, os, browser } = parseUA(ua);
  await admin.from("login_logs").insert({
    user_id: data.user.id, session_id: sid, ip, country: vpn.country, is_vpn: vpn.isVpn,
    user_agent: ua.slice(0, 400), device, os, browser,
  });
  return {
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail(405, "method", "POST만 지원합니다.");

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail(400, "bad_json", "요청 형식이 올바르지 않습니다."); }

  const ip = clientIp(req);
  const ua = req.headers.get("user-agent") ?? "";
  const action = String(body.action ?? "");

  if (action === "check") {
    const vpn = await checkVpn(ip);
    return json(200, { vpn: vpn.isVpn === true });
  }

  if (await tooManyFailures(ip)) return fail(429, "rate_limited", "로그인 시도가 너무 많습니다. 15분 뒤에 다시 시도해 주세요.");

  const vpn = await checkVpn(ip);
  if (vpn.isVpn) return fail(403, "vpn", "VPN이나 프록시를 끈 뒤 다시 시도해 주세요.");

  if (action === "signup") {
    // 같은 IP에서 1시간에 3번까지만 가입 (입력값 검사를 통과한 시도만 셈)
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: signups } = await admin.from("auth_attempts").select("id", { count: "exact", head: true })
      .eq("ip", ip).eq("identifier", "signup").gte("created_at", hourAgo);
    if ((signups ?? 0) >= 3) return fail(429, "rate_limited", "가입 시도가 너무 많습니다. 1시간 뒤에 다시 시도해 주세요.");

    const username = String(body.username ?? "").trim();
    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return fail(400, "username", "아이디는 영문·숫자·밑줄 3~20자로 입력해 주세요.");
    if (name.length < 1 || name.length > 30) return fail(400, "name", "이름은 1~30자로 입력해 주세요.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) return fail(400, "email", "이메일 형식을 확인해 주세요.");
    if (password.length < 8 || password.length > 72) return fail(400, "password", "비밀번호는 8~72자로 입력해 주세요.");
    if (body.consent !== true) return fail(400, "consent", "개인정보 수집에 동의해야 가입할 수 있습니다.");
    if (username.toLowerCase() === "hy2" && email !== "hayul120205@outlook.kr") return fail(409, "username_taken", "이미 사용 중인 아이디입니다.");

    const { data: dup } = await admin.from("profiles").select("id").ilike("username", username.replace(/_/g, "\\_")).maybeSingle();
    if (dup) return fail(409, "username_taken", "이미 사용 중인 아이디입니다.");

    await admin.from("auth_attempts").insert({ ip, identifier: "signup", success: true });
    const { data: created, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { username, name },
      app_metadata: { created_via: "hy2-edge" },
    });
    if (error || !created?.user) {
      const exists = /already|registered|exists/i.test(error?.message ?? "");
      return fail(exists ? 409 : 400, exists ? "email_taken" : "signup_failed",
        exists ? "이미 가입된 이메일입니다." : "가입하지 못했습니다. 입력값을 확인해 주세요.");
    }
    // 프로필은 서버만 만든다. 프로필이 없는 계정(우회 가입)은 로그인·문의를 쓸 수 없다.
    const { error: pErr } = await admin.from("profiles").insert({ id: created.user.id, username, name, role: "user" });
    if (pErr) {
      await admin.auth.admin.deleteUser(created.user.id);
      const taken = /duplicate|unique|reserved/i.test(pErr.message);
      return fail(taken ? 409 : 500, taken ? "username_taken" : "signup_failed",
        taken ? "이미 사용 중인 아이디입니다." : "가입하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
    const r = await signInAndLog(email, password, ip, ua, vpn);
    if ("session" in r) return json(200, r);
    return fail(500, "login_after_signup", "가입은 됐지만 로그인하지 못했습니다. 로그인 화면에서 다시 시도해 주세요.");
  }

  if (action === "login") {
    const id = String(body.identifier ?? "").trim();
    const password = String(body.password ?? "");
    if (!id || !password) return fail(400, "missing", "아이디와 비밀번호를 입력해 주세요.");

    let email = id.toLowerCase();
    if (!id.includes("@")) {
      const { data: p } = await admin.from("profiles").select("id").ilike("username", id.replace(/_/g, "\\_")).maybeSingle();
      email = "";
      if (p) {
        const { data: u } = await admin.auth.admin.getUserById(p.id);
        email = u.user?.email ?? "";
      }
    }
    const r = email ? await signInAndLog(email, password, ip, ua, vpn) : { error: true as const };
    await admin.from("auth_attempts").insert({ ip, identifier: id.slice(0, 120), success: "session" in r });
    if ("banned" in r) return fail(403, "banned", "이용이 제한된 계정입니다. 이메일로 문의해 주세요.");
    if (!("session" in r)) return fail(401, "invalid", "아이디 또는 비밀번호가 맞지 않습니다.");
    return json(200, r);
  }

  return fail(400, "unknown_action", "알 수 없는 요청입니다.");
});
