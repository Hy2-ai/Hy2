// Hy2 1:1 문의 채팅 화면 (회원 문의 페이지와 어드민 페이지에서 함께 사용)
(() => {
  const { sb, h, toast, confirmBox, errMsg, CATEGORIES, STATUS, time } = Hy2;

  function statusChip(s) { return h("span", { class: `chip ${s}`, text: STATUS[s] || s }); }

  async function mount(root, { ticketId, me, isAdmin = false, onChange = () => {} }) {
    root.replaceChildren(h("div", { class: "empty", text: "문의를 불러오는 중이에요." }));
    const { data: t, error } = await sb.from("tickets").select("*").eq("id", ticketId).maybeSingle();
    if (error || !t) { root.replaceChildren(h("div", { class: "empty", text: "문의를 찾지 못했어요." })); return () => {}; }

    // 어드민은 상대방 이름을 함께 표시
    let other = null;
    if (isAdmin) {
      const { data: p } = await sb.from("profiles").select("username, name").eq("id", t.user_id).maybeSingle();
      other = p;
    }

    const list = h("div", { class: "msgs", role: "log", "aria-live": "polite" });
    const seen = new Set();
    const nameOf = (m) => (m.sender_id === me.id ? "나" : m.sender_id === t.user_id ? (other ? `${other.name} (@${other.username})` : "나") : "Hy2");
    function addMsg(m, scroll = true) {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      const mine = m.sender_id === me.id;
      list.append(h("div", { class: `msg ${mine ? "mine" : "theirs"}` },
        h("div", { class: "bubble", text: m.body }),
        h("div", { class: "meta", text: `${mine ? "" : nameOf(m) + " · "}${time(m.created_at)}` })));
      if (scroll) list.scrollTop = list.scrollHeight;
    }

    const head = h("div", { class: "chat-head" },
      h("div", { class: "chat-title" },
        h("div", { class: "chat-tags" }, h("span", { class: "chip", text: CATEGORIES[t.category]?.label || t.category }), statusChip(t.status)),
        h("h2", { text: t.title }),
        h("p", { class: "muted", text: `용도: ${t.purpose}${other ? ` · 의뢰인: ${other.name} (@${other.username})` : ""}` })),
      h("div", { class: "chat-actions" }));
    const actions = head.querySelector(".chat-actions");

    const input = h("textarea", { class: "input", id: "chat-input", rows: "2", maxlength: "2000", placeholder: "메시지를 입력하세요 (Enter 전송, Shift+Enter 줄바꿈)", "aria-label": "메시지" });
    const sendBtn = h("button", { class: "btn btn-primary", type: "submit" }, "보내기");
    const composer = h("form", { class: "composer", onsubmit: async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      sendBtn.disabled = true;
      const { data, error } = await sb.from("messages").insert({ ticket_id: t.id, sender_id: me.id, body }).select().single();
      sendBtn.disabled = false;
      if (error) { toast(t.status === "closed" ? "종료된 문의에는 메시지를 보낼 수 없어요." : errMsg(error)); return; }
      input.value = "";
      addMsg(data);
      onChange();
    } }, input, sendBtn);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); composer.requestSubmit(); }
    });

    const footer = h("div", { class: "chat-foot" });
    root.replaceChildren(h("div", { class: "chat" }, head, list, footer));

    async function paintFooter() {
      actions.replaceChildren();
      footer.replaceChildren();
      if (t.status !== "closed") {
        actions.append(h("button", { class: "btn btn-quiet btn-sm", type: "button", onclick: async () => {
          const ok = await confirmBox({ title: "문의를 종료할까요?", body: isAdmin ? "종료하면 의뢰인이 후기를 남길 수 있어요." : "종료하면 메시지를 더 보낼 수 없고, 후기를 남길 수 있어요.", ok: "종료하기" });
          if (!ok) return;
          const { error } = await sb.rpc("close_ticket", { p_ticket: t.id });
          if (error) return toast(errMsg(error));
          t.status = "closed"; refreshHead(); paintFooter(); onChange();
        } }, "문의 종료"));
        footer.append(composer);
        return;
      }
      if (isAdmin) {
        actions.append(h("button", { class: "btn btn-quiet btn-sm", type: "button", onclick: async () => {
          const { error } = await sb.rpc("reopen_ticket", { p_ticket: t.id });
          if (error) return toast(errMsg(error));
          t.status = "answered"; refreshHead(); paintFooter(); onChange();
        } }, "다시 열기"));
        footer.append(h("p", { class: "closed-note", text: "종료된 문의입니다." }));
        return;
      }
      const { data: reviewed } = await sb.rpc("has_reviewed", { p_ticket: t.id });
      if (reviewed) { footer.append(h("p", { class: "closed-note", text: "종료된 문의예요. 후기를 남겨 주셔서 감사합니다!" })); return; }
      footer.append(reviewForm());
    }

    function reviewForm() {
      let rating = 5;
      const stars = h("div", { class: "star-pick", role: "radiogroup", "aria-label": "별점" });
      const paint = () => [...stars.children].forEach((b, i) => { b.classList.toggle("on", i < rating); b.setAttribute("aria-checked", i + 1 === rating); });
      for (let i = 1; i <= 5; i++) stars.append(h("button", { type: "button", role: "radio", "aria-label": `${i}점`, onclick: () => { rating = i; paint(); } }, "★"));
      paint();
      const ta = h("textarea", { class: "input", id: "review-body", maxlength: "300", rows: "3", placeholder: "작업은 어땠나요? (5~300자, 홈 화면에 이름 첫 글자와 함께 공개돼요)" });
      const msg = h("p", { class: "form-msg" });
      return h("form", { class: "review-form", onsubmit: async (e) => {
        e.preventDefault();
        const body = ta.value.trim();
        if (body.length < 5) { msg.textContent = "후기는 5자 이상 적어 주세요."; return; }
        const { error } = await sb.rpc("submit_review", { p_ticket: t.id, p_rating: rating, p_body: body });
        if (error) { msg.textContent = errMsg(error); return; }
        toast("후기를 남겼어요. 감사합니다!");
        paintFooter();
      } }, h("b", { text: "문의가 종료됐어요. 후기를 남겨 주세요" }), stars, ta, msg,
        h("div", { style: "display:flex;justify-content:flex-end" }, h("button", { class: "btn btn-primary btn-sm", type: "submit" }, "후기 남기기")));
    }

    function refreshHead() {
      const tags = head.querySelector(".chat-tags");
      tags.lastChild.replaceWith(statusChip(t.status));
    }

    const { data: msgs } = await sb.from("messages").select("*").eq("ticket_id", t.id).order("created_at");
    (msgs || []).forEach((m) => addMsg(m, false));
    list.scrollTop = list.scrollHeight;
    paintFooter();

    // 실시간: 새 메시지와 상태 변경
    const ch = sb.channel(`ticket-${t.id}-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `ticket_id=eq.${t.id}` }, (p) => { addMsg(p.new); onChange(); })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "tickets", filter: `id=eq.${t.id}` }, (p) => {
        const was = t.status; Object.assign(t, p.new);
        if (was !== t.status) { refreshHead(); paintFooter(); onChange(); }
      })
      .subscribe();
    if (t.status !== "closed") input.focus();
    return () => sb.removeChannel(ch);
  }

  window.Hy2Chat = { mount, statusChip };
})();
