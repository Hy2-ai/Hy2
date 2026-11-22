-- Hy2 core schema: profiles, login logs, inquiries (1:1 chat), reviews
-- 모든 사용자 데이터는 RLS로 보호되고, 세션은 Edge Function을 거쳐 기록된 것만 유효합니다.

create extension if not exists pg_cron;

-- ───────────────────────── 프로필 ─────────────────────────
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null,
  name        text not null check (char_length(name) between 1 and 30),
  role        text not null default 'user' check (role in ('user','admin')),
  is_banned   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint username_format check (username ~ '^[A-Za-z0-9_]{3,20}$')
);
create unique index profiles_username_lower on public.profiles (lower(username));

-- ───────────────────────── 로그인 기록 (3개월 보관) ─────────────────────────
create table public.login_logs (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  session_id  uuid not null,
  ip          text,
  country     text,
  is_vpn      boolean,
  user_agent  text,
  device      text,
  os          text,
  browser     text,
  created_at  timestamptz not null default now()
);
create index login_logs_session on public.login_logs (session_id);
create index login_logs_user_time on public.login_logs (user_id, created_at desc);
create index login_logs_time on public.login_logs (created_at);

-- 서버 전용 테이블 (클라이언트 접근 불가)
create table public.auth_attempts (
  id          bigint generated always as identity primary key,
  ip          text,
  identifier  text,
  success     boolean not null,
  created_at  timestamptz not null default now()
);
create index auth_attempts_ip_time on public.auth_attempts (ip, created_at desc);

create table public.vpn_cache (
  ip          text primary key,
  is_vpn      boolean not null,
  detail      text,
  checked_at  timestamptz not null default now()
);

-- ───────────────────────── 문의 ─────────────────────────
create table public.tickets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  category    text not null check (category in ('discord','telegram','kakao','ai','web','automation','etc')),
  purpose     text not null check (char_length(purpose) between 1 and 200),
  title       text not null check (char_length(title) between 1 and 80),
  status      text not null default 'open' check (status in ('open','answered','closed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  closed_at   timestamptz
);
create index tickets_user on public.tickets (user_id, updated_at desc);
create index tickets_updated on public.tickets (updated_at desc);

create table public.messages (
  id          bigint generated always as identity primary key,
  ticket_id   uuid not null references public.tickets(id) on delete cascade,
  sender_id   uuid references public.profiles(id) on delete set null,
  body        text not null check (char_length(body) between 1 and 2000),
  created_at  timestamptz not null default now()
);
create index messages_ticket on public.messages (ticket_id, created_at);

-- ───────────────────────── 후기 (최신 10개만 유지) ─────────────────────────
create table public.reviews (
  id            bigint generated always as identity primary key,
  ticket_id     uuid unique references public.tickets(id) on delete set null,
  display_name  text not null,
  category      text not null,
  rating        int not null check (rating between 1 and 5),
  body          text not null check (char_length(body) between 5 and 300),
  created_at    timestamptz not null default now()
);

-- ───────────────────────── 헬퍼 함수 ─────────────────────────
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' and not p.is_banned);
$$;

-- 세션 유효성: Edge Function으로 로그인해 기록이 남은 세션 + 7일 이내 + 차단 아님 + (OTP 사용자는 aal2)
create or replace function public.session_ok()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  sid uuid;
  uid uuid := auth.uid();
begin
  if uid is null then return false; end if;
  begin
    sid := (auth.jwt() ->> 'session_id')::uuid;
  exception when others then return false;
  end;
  if sid is null then return false; end if;
  if not exists (
    select 1 from public.login_logs l
    where l.session_id = sid and l.user_id = uid and l.created_at > now() - interval '7 days'
  ) then return false; end if;
  if exists (select 1 from public.profiles p where p.id = uid and p.is_banned) then return false; end if;
  if exists (select 1 from auth.mfa_factors f where f.user_id = uid and f.status = 'verified')
     and coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    return false;
  end if;
  return true;
end;
$$;

create or replace function public.is_admin_session()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.session_ok() and public.is_admin();
$$;

-- 새 사용자 → 프로필 생성 (Edge Function으로 만든 계정만 허용, Hy2는 지정 이메일만)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  uname text := new.raw_user_meta_data ->> 'username';
  nm    text := coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), uname);
  r     text := 'user';
begin
  if coalesce(new.raw_app_meta_data ->> 'created_via', '') <> 'hy2-edge' then
    raise exception 'signup_not_allowed';
  end if;
  if lower(uname) = 'hy2' then
    if lower(new.email) <> 'hayul120205@outlook.kr' then
      raise exception 'reserved_username';
    end if;
    r := 'admin';
  end if;
  insert into public.profiles (id, username, name, role) values (new.id, uname, nm, r);
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 일반 사용자는 자기 이름만 바꿀 수 있음
create or replace function public.protect_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() = 'service_role' or public.is_admin() then
    new.updated_at := now();
    return new;
  end if;
  if new.role is distinct from old.role or new.is_banned is distinct from old.is_banned
     or new.username is distinct from old.username or new.id is distinct from old.id then
    raise exception 'not_allowed';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger profiles_protect before update on public.profiles
  for each row execute function public.protect_profile();

-- 메시지가 오면 문의 상태/시간 갱신
create or replace function public.on_message_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.tickets t
     set updated_at = now(),
         status = case when exists (select 1 from public.profiles p where p.id = new.sender_id and p.role = 'admin')
                       then 'answered' else 'open' end
   where t.id = new.ticket_id and t.status <> 'closed';
  return new;
end;
$$;
create trigger messages_after_insert after insert on public.messages
  for each row execute function public.on_message_insert();

-- 후기는 최신 10개만 유지
create or replace function public.trim_reviews()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.reviews where id in (
    select id from public.reviews order by created_at desc, id desc offset 10
  );
  return null;
end;
$$;
create trigger reviews_trim after insert on public.reviews
  for each statement execute function public.trim_reviews();

-- ───────────────────────── RPC ─────────────────────────
create or replace function public.create_ticket(p_category text, p_purpose text, p_title text, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare tid uuid;
begin
  if not public.session_ok() then raise exception 'session_invalid'; end if;
  if (select count(*) from public.tickets where user_id = auth.uid() and created_at > now() - interval '1 day') >= 10 then
    raise exception 'too_many_tickets';
  end if;
  insert into public.tickets (user_id, category, purpose, title)
    values (auth.uid(), p_category, trim(p_purpose), trim(p_title)) returning id into tid;
  insert into public.messages (ticket_id, sender_id, body) values (tid, auth.uid(), trim(p_body));
  return tid;
end;
$$;

create or replace function public.close_ticket(p_ticket uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.session_ok() then raise exception 'session_invalid'; end if;
  update public.tickets set status = 'closed', closed_at = now(), updated_at = now()
   where id = p_ticket and status <> 'closed' and (user_id = auth.uid() or public.is_admin());
  if not found then raise exception 'not_found'; end if;
end;
$$;

create or replace function public.reopen_ticket(p_ticket uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin_session() then raise exception 'not_allowed'; end if;
  update public.tickets set status = 'answered', closed_at = null, updated_at = now() where id = p_ticket;
end;
$$;

create or replace function public.submit_review(p_ticket uuid, p_rating int, p_body text)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.tickets; nm text;
begin
  if not public.session_ok() then raise exception 'session_invalid'; end if;
  select * into t from public.tickets where id = p_ticket and user_id = auth.uid();
  if t.id is null then raise exception 'not_found'; end if;
  if t.status <> 'closed' then raise exception 'ticket_not_closed'; end if;
  if exists (select 1 from public.reviews where ticket_id = p_ticket) then raise exception 'already_reviewed'; end if;
  select name into nm from public.profiles where id = auth.uid();
  -- 이름 가리기: 첫 글자 + *
  nm := left(nm, 1) || repeat('*', greatest(char_length(nm) - 1, 1));
  insert into public.reviews (ticket_id, display_name, category, rating, body)
    values (p_ticket, nm, t.category, p_rating, trim(p_body));
end;
$$;

create or replace function public.has_reviewed(p_ticket uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.reviews r join public.tickets t on t.id = r.ticket_id
                 where r.ticket_id = p_ticket and (t.user_id = auth.uid() or public.is_admin()));
$$;

-- 어드민: 회원 목록 (OTP 여부, 마지막 로그인 IP/기기 포함)
create or replace function public.admin_list_users()
returns table (
  id uuid, username text, name text, email text, role text, is_banned boolean,
  created_at timestamptz, mfa_enabled boolean, login_count bigint,
  last_login_at timestamptz, last_ip text, last_device text, last_vpn boolean, ticket_count bigint
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin_session() then raise exception 'not_allowed'; end if;
  return query
  select p.id, p.username, p.name, u.email::text, p.role, p.is_banned, p.created_at,
         exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified'),
         (select count(*) from public.login_logs l where l.user_id = p.id),
         ll.created_at, ll.ip, concat_ws(' · ', ll.device, ll.os, ll.browser), ll.is_vpn,
         (select count(*) from public.tickets t where t.user_id = p.id)
    from public.profiles p
    join auth.users u on u.id = p.id
    left join lateral (
      select * from public.login_logs l where l.user_id = p.id order by l.created_at desc limit 1
    ) ll on true
   order by p.created_at desc;
end;
$$;

-- 서버 전용: 세션 강제 종료
create or replace function public.revoke_user_sessions(p_user uuid)
returns void language sql security definer set search_path = '' as $$
  delete from auth.sessions where user_id = p_user;
$$;
revoke all on function public.revoke_user_sessions(uuid) from public, anon, authenticated;

-- 실행 권한 정리
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.protect_profile() from public, anon, authenticated;
revoke all on function public.on_message_insert() from public, anon, authenticated;
revoke all on function public.trim_reviews() from public, anon, authenticated;
revoke execute on function public.create_ticket(text,text,text,text) from public, anon;
revoke execute on function public.close_ticket(uuid) from public, anon;
revoke execute on function public.reopen_ticket(uuid) from public, anon;
revoke execute on function public.submit_review(uuid,int,text) from public, anon;
revoke execute on function public.has_reviewed(uuid) from public, anon;
revoke execute on function public.admin_list_users() from public, anon;

-- ───────────────────────── RLS ─────────────────────────
alter table public.profiles      enable row level security;
alter table public.login_logs    enable row level security;
alter table public.auth_attempts enable row level security;
alter table public.vpn_cache     enable row level security;
alter table public.tickets       enable row level security;
alter table public.messages      enable row level security;
alter table public.reviews       enable row level security;

revoke all on public.auth_attempts, public.vpn_cache from anon, authenticated;
revoke all on public.login_logs from anon;
revoke insert, update, delete on public.login_logs from authenticated;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (public.session_ok() and (id = auth.uid() or public.is_admin()));
create policy profiles_update on public.profiles for update to authenticated
  using (public.session_ok() and (id = auth.uid() or public.is_admin()))
  with check (public.session_ok() and (id = auth.uid() or public.is_admin()));

-- login_logs
create policy logs_select on public.login_logs for select to authenticated
  using (public.session_ok() and (user_id = auth.uid() or public.is_admin()));

-- tickets
create policy tickets_select on public.tickets for select to authenticated
  using (public.session_ok() and (user_id = auth.uid() or public.is_admin()));
create policy tickets_admin_update on public.tickets for update to authenticated
  using (public.is_admin_session()) with check (public.is_admin_session());
create policy tickets_admin_delete on public.tickets for delete to authenticated
  using (public.is_admin_session());

-- messages
create policy messages_select on public.messages for select to authenticated
  using (public.session_ok() and exists (
    select 1 from public.tickets t where t.id = ticket_id and (t.user_id = auth.uid() or public.is_admin())));
create policy messages_insert on public.messages for insert to authenticated
  with check (public.session_ok() and sender_id = auth.uid() and exists (
    select 1 from public.tickets t where t.id = ticket_id and t.status <> 'closed'
      and (t.user_id = auth.uid() or public.is_admin())));

-- reviews: 누구나 읽기 (공개 컬럼만), 어드민만 삭제
revoke all on public.reviews from anon, authenticated;
grant select (id, display_name, category, rating, body, created_at) on public.reviews to anon, authenticated;
grant delete on public.reviews to authenticated;
create policy reviews_public_select on public.reviews for select to anon, authenticated using (true);
create policy reviews_admin_delete on public.reviews for delete to authenticated using (public.is_admin_session());

-- 직접 쓰기 막기 (RPC로만)
revoke insert, delete on public.tickets from anon, authenticated;
revoke all on public.tickets from anon;
revoke all on public.messages from anon;
revoke update, delete on public.messages from authenticated;
revoke all on public.profiles from anon;
revoke insert, delete on public.profiles from authenticated;

-- ───────────────────────── 실시간 채팅 ─────────────────────────
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.tickets;

-- ───────────────────────── 자동 정리 ─────────────────────────
-- 로그인 IP·기기 기록: 3개월 후 삭제 / 보조 테이블: 1일 후 삭제
select cron.schedule('hy2-purge-logs', '17 3 * * *', $$
  delete from public.login_logs where created_at < now() - interval '3 months';
  delete from public.auth_attempts where created_at < now() - interval '1 day';
  delete from public.vpn_cache where checked_at < now() - interval '1 day';
$$);
-- 로그인 유지 7일: 오래된 세션을 지워 재로그인 강제
select cron.schedule('hy2-expire-sessions', '7 * * * *', $$
  delete from auth.sessions where created_at < now() - interval '7 days';
$$);
