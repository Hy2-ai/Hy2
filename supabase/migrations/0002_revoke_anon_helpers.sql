-- 로그인하지 않은 사용자는 세션·어드민 확인 함수를 호출할 수 없게 함
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_admin_session() from public, anon;
revoke execute on function public.session_ok() from public, anon;
grant execute on function public.is_admin(), public.is_admin_session(), public.session_ok() to authenticated;
