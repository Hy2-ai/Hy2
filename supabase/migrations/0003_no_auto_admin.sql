-- 가입만으로 어드민이 되지 않게 함. 어드민 지정은 DB에서 직접 (본인 확인 후)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  uname text := new.raw_user_meta_data ->> 'username';
  nm    text := coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), uname);
begin
  if coalesce(new.raw_app_meta_data ->> 'created_via', '') <> 'hy2-edge' then
    raise exception 'signup_not_allowed';
  end if;
  if lower(uname) = 'hy2' and lower(new.email) <> 'hayul120205@outlook.kr' then
    raise exception 'reserved_username';
  end if;
  insert into public.profiles (id, username, name, role) values (new.id, uname, nm, 'user');
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;
