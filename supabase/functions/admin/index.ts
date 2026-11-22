// Hy2 admin: 어드민 전용 계정 관리 (비밀번호·이름·이메일 재설정, OTP 초기화, 이용 제한, 세션 종료)
// 호출자가 유효한 어드민 세션(로그인 기록 + 7일 이내 + OTP 사용 시 aal2)인지 DB에서 확인합니다.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (status: number, code: string, message: string) => json(status, { error: code, message });
const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail(405, "method", "POST만 지원합니다.");

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return fail(401, "no_auth", "로그인이 필요합니다.");
  const caller = createClient(URL, ANON, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: ok, error: okErr } = await caller.rpc("is_admin_session");
  if (okErr || ok !== true) return fail(403, "forbidden", "어드민만 사용할 수 있습니다.");
  const { data: me } = await caller.auth.getUser();
  const myId = me.user?.id;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail(400, "bad_json", "요청 형식이 올바르지 않습니다."); }
  const action = String(body.action ?? "");
  const userId = body.user_id;
  if (!isUuid(userId)) return fail(400, "user_id", "대상 회원이 올바르지 않습니다.");
  const uid = userId as string;

  switch (action) {
    case "reset_password": {
      const pw = String(body.password ?? "");
      if (pw.length < 8 || pw.length > 72) return fail(400, "password", "비밀번호는 8~72자로 입력해 주세요.");
      const { error } = await admin.auth.admin.updateUserById(uid, { password: pw });
      if (error) return fail(400, "failed", "비밀번호를 바꾸지 못했습니다.");
      if (uid !== myId) await admin.rpc("revoke_user_sessions", { p_user: uid });
      return json(200, { ok: true });
    }
    case "update_user": {
      const patch: Record<string, string> = {};
      if (typeof body.name === "string") {
        const n = body.name.trim();
        if (n.length < 1 || n.length > 30) return fail(400, "name", "이름은 1~30자로 입력해 주세요.");
        patch.name = n;
      }
      if (typeof body.username === "string") {
        const u = body.username.trim();
        if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) return fail(400, "username", "아이디는 영문·숫자·밑줄 3~20자입니다.");
        if (u.toLowerCase() === "hy2" && uid !== myId) return fail(409, "username_taken", "예약된 아이디입니다.");
        const { data: dup } = await admin.from("profiles").select("id").ilike("username", u.replace(/_/g, "\\_")).neq("id", uid).maybeSingle();
        if (dup) return fail(409, "username_taken", "이미 사용 중인 아이디입니다.");
        patch.username = u;
      }
      if (Object.keys(patch).length) {
        const { error } = await admin.from("profiles").update(patch).eq("id", uid);
        if (error) return fail(400, "failed", "회원 정보를 바꾸지 못했습니다.");
      }
      if (typeof body.email === "string" && body.email.trim()) {
        const e = body.email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return fail(400, "email", "이메일 형식을 확인해 주세요.");
        const { error } = await admin.auth.admin.updateUserById(uid, { email: e, email_confirm: true });
        if (error) return fail(400, "email_failed", "이메일을 바꾸지 못했습니다. 이미 쓰는 주소일 수 있습니다.");
      }
      return json(200, { ok: true });
    }
    case "reset_mfa": {
      const { data, error } = await admin.auth.admin.mfa.listFactors({ userId: uid });
      if (error) return fail(400, "failed", "OTP 정보를 불러오지 못했습니다.");
      for (const f of data.factors ?? []) {
        await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: uid });
      }
      await admin.rpc("revoke_user_sessions", { p_user: uid });
      return json(200, { ok: true, removed: data.factors?.length ?? 0 });
    }
    case "set_ban": {
      if (uid === myId) return fail(400, "self", "내 계정은 제한할 수 없습니다.");
      const banned = body.banned === true;
      const { error } = await admin.from("profiles").update({ is_banned: banned }).eq("id", uid);
      if (error) return fail(400, "failed", "상태를 바꾸지 못했습니다.");
      if (banned) await admin.rpc("revoke_user_sessions", { p_user: uid });
      return json(200, { ok: true });
    }
    case "revoke_sessions": {
      await admin.rpc("revoke_user_sessions", { p_user: uid });
      return json(200, { ok: true });
    }
    case "delete_user": {
      if (uid === myId) return fail(400, "self", "내 계정은 삭제할 수 없습니다.");
      const { error } = await admin.auth.admin.deleteUser(uid);
      if (error) return fail(400, "failed", "회원을 삭제하지 못했습니다.");
      return json(200, { ok: true });
    }
  }
  return fail(400, "unknown_action", "알 수 없는 요청입니다.");
});
