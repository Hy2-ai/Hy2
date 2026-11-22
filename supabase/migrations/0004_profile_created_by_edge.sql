-- 가입 트리거가 정상 가입까지 막던 문제 수정: 프로필은 Edge Function이 서버 권한으로 만든다.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

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
