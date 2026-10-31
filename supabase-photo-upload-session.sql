-- อัปโหลดรูป (/api/photos/upload) ต้องมาจากเครื่องที่ล็อกอินอยู่
-- รันใน Supabase SQL Editor ก่อน merge PR · รันซ้ำได้
-- ตรวจโทเค็นเซสชัน (จาก sjwd_login) ว่ายังไม่หมดอายุ — คืนแค่ true/false
create or replace function public.sjwd_session_ok(p_token text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_sessions where token = p_token and expires_at > now());
$$;
revoke all on function public.sjwd_session_ok(text) from public;
grant execute on function public.sjwd_session_ok(text) to anon, authenticated;

-- ตรวจ: ต้องได้ false
select public.sjwd_session_ok('not-a-token') as ok_should_be_false;
