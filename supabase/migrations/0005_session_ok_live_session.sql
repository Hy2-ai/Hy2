-- 강제 로그아웃·비밀번호 재설정 시 기존 로그인이 즉시 끊기도록 auth.sessions 존재 여부도 확인
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
  if not exists (select 1 from auth.sessions s where s.id = sid and s.user_id = uid) then return false; end if;
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
revoke execute on function public.session_ok() from public, anon;
grant execute on function public.session_ok() to authenticated;
