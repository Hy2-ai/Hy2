-- 가입 트리거가 정상 가입까지 막던 문제 수정: 프로필은 Edge Function이 서버 권한으로 만든다.
-- (실제 적용: 트리거는 남기고 함수를 아무 일도 하지 않게 교체)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  return new;
end;
$$;

-- Hy2 아이디는 지정 이메일 계정만 쓸 수 있음 (가입·변경 모두)
create or replace function public.check_reserved_username()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if lower(new.username) = 'hy2'
     and coalesce((select lower(u.email) from auth.users u where u.id = new.id), '') <> 'hayul120205@outlook.kr' then
    raise exception 'reserved_username';
  end if;
  return new;
end;
$$;
revoke all on function public.check_reserved_username() from public, anon, authenticated;
create trigger profiles_reserved_username before insert or update of username on public.profiles
  for each row execute function public.check_reserved_username();

-- SQL Editor·서버 작업(로그인 사용자 없음)에서는 권한 변경 허용, 회원 본인은 여전히 role/is_banned/username 변경 불가
create or replace function public.protect_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or auth.role() = 'service_role' or public.is_admin() then
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
