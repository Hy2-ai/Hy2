// Hy2 공통 스크립트: Supabase 연결, 로그인 상태, DOM 헬퍼, 배경 애니메이션
// anon 키는 공개용 키입니다. 모든 데이터는 DB의 RLS 정책으로 보호됩니다.
(() => {
  const SUPABASE_URL = "https://qoyngutpzhutpimjgbtz.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFveW5ndXRwemh1dHBpbWpnYnR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUyODEzNjQsImV4cCI6MjExMDg1NzM2NH0.upS_4mMllZFjJ_lWbIIGALF8ZCJlchMZ2fy4bUZ6Cao";

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "hy2-auth" },
  });

  const CATEGORIES = {
    discord:    { label: "디스코드 봇",   desc: "서버 관리·출석·포인트·미니게임", purposes: ["서버 관리", "출석·포인트", "티켓·문의 접수", "게임 커뮤니티", "음악·알림"] },
    telegram:   { label: "텔레그램 봇",   desc: "알림·그룹 관리·자동 응답",       purposes: ["가격·코인 알림", "그룹 관리", "자동 응답", "결제·주문 안내"] },
    kakao:      { label: "카카오톡 챗봇", desc: "채널 상담·예약·주문 안내",       purposes: ["자주 묻는 질문", "예약 안내", "주문 안내", "가게 홍보"] },
    ai:         { label: "AI 챗봇",       desc: "내 자료로 답하는 상담 AI",       purposes: ["고객 상담", "사내 문서 검색", "디스코드 연동", "웹사이트 위젯"] },
    web:        { label: "웹사이트",      desc: "홈페이지·랜딩·작은 서비스",      purposes: ["개인 홈페이지", "가게·팀 소개", "랜딩 페이지", "관리자 페이지"] },
    automation: { label: "업무 자동화",   desc: "반복 작업·데이터 정리",          purposes: ["데이터 수집", "시트 자동 정리", "알림 자동화", "정기 실행 작업"] },
    etc:        { label: "기타 문의",     desc: "협업 제안·견적·그 밖의 질문",    purposes: ["견적 문의", "협업 제안", "기존 작업 수정", "그 외"] },
  };
  const STATUS = { open: "답변 대기", answered: "답변 완료", closed: "종료" };

  // ── DOM 헬퍼 (텍스트는 항상 textContent로 넣어 XSS 방지) ──
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const fmt = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Seoul" });
  const fmtFull = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Seoul" });
  const time = (d) => (d ? fmt.format(new Date(d)) : "-");
  const timeFull = (d) => (d ? fmtFull.format(new Date(d)) : "-");
  function ago(d) {
    const s = (Date.now() - new Date(d)) / 1000;
    if (s < 60) return "방금";
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`;
    return time(d);
  }

  let toastTimer;
  function toast(msg) {
    let t = $("#toast");
    if (!t) { t = h("div", { id: "toast", class: "toast", role: "status", "aria-live": "polite" }); document.body.append(t); }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  async function copyText(text, okMsg = "복사했어요.") {
    try { await navigator.clipboard.writeText(text); toast(okMsg); }
    catch { toast("복사하지 못했어요. 길게 눌러 직접 복사해 주세요."); }
  }

  // 확인 창 (window.confirm 대신)
  function confirmBox({ title, body, ok = "확인", danger = false }) {
    return new Promise((resolve) => {
      const close = (v) => { m.remove(); resolve(v); };
      const m = h("div", { class: "modal", onclick: (e) => e.target === m && close(false) },
        h("div", { class: "modal-card glass", role: "dialog", "aria-modal": "true" },
          h("h3", { text: title }),
          body ? h("p", { class: "muted", text: body }) : null,
          h("div", { class: "modal-actions" },
            h("button", { class: "btn btn-quiet btn-sm", type: "button", onclick: () => close(false) }, "취소"),
            h("button", { class: `btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`, type: "button", onclick: () => close(true) }, ok))));
      document.body.append(m);
      m.querySelector(".btn-primary, .btn-danger").focus();
    });
  }

  // 입력 창이 있는 모달
  function formBox({ title, fields, ok = "저장" }) {
    return new Promise((resolve) => {
      const close = (v) => { m.remove(); resolve(v); };
      const inputs = fields.map((f) => h("div", { class: "field" },
        h("label", { for: `fb-${f.name}`, text: f.label }),
        h("input", { class: "input", id: `fb-${f.name}`, name: f.name, type: f.type || "text", value: f.value ?? "", autocomplete: "off", placeholder: f.placeholder || "" }),
        f.hint ? h("span", { class: "hint", text: f.hint }) : null));
      const form = h("form", { class: "modal-card glass", onsubmit: (e) => {
        e.preventDefault();
        const out = {};
        for (const f of fields) out[f.name] = form.querySelector(`[name="${f.name}"]`).value;
        close(out);
      } },
        h("h3", { text: title }), ...inputs,
        h("div", { class: "modal-actions" },
          h("button", { class: "btn btn-quiet btn-sm", type: "button", onclick: () => close(null) }, "취소"),
          h("button", { class: "btn btn-primary btn-sm", type: "submit" }, ok)));
      const m = h("div", { class: "modal", onclick: (e) => e.target === m && close(null) }, form);
      document.body.append(m);
      form.querySelector("input")?.focus();
    });
  }

  // ── 서버 함수 호출 ──
  async function callFn(name, body, withAuth = false) {
    const headers = { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY };
    if (withAuth) {
      const { data } = await sb.auth.getSession();
      if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
    }
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
    } catch {
      return { ok: false, error: "network", message: "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ...data };
  }

  const ERR = {
    session_invalid: "로그인이 만료됐어요. 다시 로그인해 주세요.",
    too_many_tickets: "하루에 문의는 10개까지 만들 수 있어요.",
    ticket_not_closed: "종료된 문의에만 후기를 남길 수 있어요.",
    already_reviewed: "이미 후기를 남긴 문의예요.",
    not_found: "문의를 찾지 못했어요.",
    not_allowed: "권한이 없어요.",
  };
  const errMsg = (e) => {
    const m = e?.message || "";
    for (const k of Object.keys(ERR)) if (m.includes(k)) return ERR[k];
    return "처리하지 못했어요. 잠시 후 다시 시도해 주세요.";
  };

  // ── 세션 확인: 로그인 기록이 남은 7일 이내 세션 + OTP 단계 통과 ──
  async function currentUser() {
    const { data } = await sb.auth.getSession();
    if (!data.session) return null;
    const { data: ok } = await sb.rpc("session_ok");
    if (ok !== true) return { needsOtp: await needsOtp(), session: data.session };
    const { data: prof } = await sb.from("profiles").select("id, username, name, role").eq("id", data.session.user.id).maybeSingle();
    return prof ? { ...prof, email: data.session.user.email } : null;
  }
  async function needsOtp() {
    const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    return data?.nextLevel === "aal2" && data?.currentLevel !== "aal2";
  }
  async function requireUser({ admin = false } = {}) {
    const u = await currentUser();
    const back = encodeURIComponent(location.pathname.replace(/^\//, "") + location.hash);
    if (!u) { location.replace(`login.html?next=${back}`); return null; }
    if (u.needsOtp) { location.replace(`login.html?otp=1&next=${back}`); return null; }
    if (!u.id) { await sb.auth.signOut(); location.replace(`login.html?expired=1&next=${back}`); return null; }
    if (admin && u.role !== "admin") { location.replace("inquiry.html"); return null; }
    return u;
  }
  async function logout() {
    await sb.auth.signOut();
    location.href = "index.html";
  }

  // 상단 메뉴의 로그인 상태: 로그인 전 → 로그인·문의하기 / 로그인 후 → 내 문의 + 프로필 메뉴
  async function navUser() {
    const { data } = await sb.auth.getSession();
    if (!data.session) return null;
    try {
      const { data: ok } = await sb.rpc("session_ok");
      if (ok !== true) return null;
      const { data: p } = await sb.from("profiles").select("username, name, role").eq("id", data.session.user.id).maybeSingle();
      return p || null;
    } catch { return null; }
  }

  async function paintNav() {
    const slot = $("#nav-auth");
    if (!slot) return;
    const page = location.pathname.split("/").pop() || "index.html";
    const me = await navUser();
    slot.replaceChildren();
    if (!me) {
      slot.append(h("a", { class: "btn btn-quiet btn-sm btn-pill", href: "login.html" }, "로그인"));
      slot.append(h("a", { class: "btn btn-primary btn-sm btn-pill", href: "login.html?mode=signup" }, "회원가입"));
      return;
    }
    if (!page.startsWith("inquiry")) slot.append(h("a", { class: "btn btn-primary btn-sm btn-pill", href: "inquiry.html" }, "내 문의"));

    const menu = h("div", { class: "user-menu glass", id: "user-menu", role: "menu", hidden: true },
      h("div", { class: "um-head" },
        h("span", { class: "avatar", "aria-hidden": "true", text: me.name.slice(0, 1) }),
        h("div", {}, h("b", { text: me.name }), h("small", { text: `@${me.username}${me.role === "admin" ? " · 어드민" : ""}` }))),
      h("a", { role: "menuitem", href: "inquiry.html" }, "내 문의"),
      h("a", { role: "menuitem", href: "inquiry.html?account=1" }, "내 정보 · 보안"),
      me.role === "admin" ? h("a", { role: "menuitem", href: "admin.html" }, "관리자 페이지") : null,
      h("hr"),
      h("button", { role: "menuitem", type: "button", class: "danger", onclick: logout }, "로그아웃"));
    const btn = h("button", { class: "user-btn", type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": "user-menu", "aria-label": `${me.name} 계정 메뉴` },
      h("span", { class: "avatar", "aria-hidden": "true", text: me.name.slice(0, 1) }));
    const toggle = (open) => {
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", open);
      if (open) menu.querySelector("a,button")?.focus();
    };
    btn.addEventListener("click", (e) => { e.stopPropagation(); toggle(menu.hidden); });
    document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target)) toggle(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { toggle(false); btn.focus(); } });
    slot.append(h("div", { class: "user-wrap" }, btn, menu));
  }

  // ── 배경: 유리 뒤에서 천천히 흐르는 색 원반 ──
  function orbs() {
    const cv = $("#orbs");
    if (!cv) return;
    const ctx = cv.getContext("2d");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    let W = 0, H = 0, colors = [];
    const list = [
      { x: .16, y: .2, r: .28, c: 0, sx: .00011, sy: .00008, p: 0 },
      { x: .84, y: .16, r: .22, c: 1, sx: .00009, sy: .00012, p: 2 },
      { x: .7, y: .74, r: .3, c: 2, sx: .00007, sy: .0001, p: 4 },
      { x: .22, y: .84, r: .2, c: 1, sx: .00012, sy: .00007, p: 1 },
    ];
    const read = () => { colors = [css("--orb-a"), css("--orb-b"), css("--orb-c")]; };
    const size = () => {
      const dpr = Math.min(devicePixelRatio || 1, 1.5);
      W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const draw = (t) => {
      ctx.clearRect(0, 0, W, H);
      ctx.filter = "blur(60px)";
      const m = Math.min(W, H) + Math.max(W, H) * .25;
      for (const o of list) {
        ctx.fillStyle = colors[o.c];
        ctx.beginPath();
        ctx.arc((o.x + Math.sin(t * o.sx + o.p) * .06) * W, (o.y + Math.cos(t * o.sy + o.p) * .06) * H, o.r * m, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.filter = "none";
      if (!reduce && !document.hidden) requestAnimationFrame(draw);
    };
    read(); size();
    addEventListener("resize", () => { size(); if (reduce) draw(0); });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { read(); if (reduce) draw(0); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && !reduce) requestAnimationFrame(draw); });
    reduce ? draw(0) : requestAnimationFrame(draw);
  }

  document.addEventListener("DOMContentLoaded", () => { orbs(); paintNav(); });

  window.Hy2 = { sb, h, $, $$, time, timeFull, ago, toast, copyText, confirmBox, formBox, callFn, errMsg,
    currentUser, requireUser, needsOtp, logout, CATEGORIES, STATUS, SUPABASE_URL };
})();
