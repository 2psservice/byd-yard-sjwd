-- ความปลอดภัย ระยะ 1 — ตรวจรหัสผ่านในฐานข้อมูล · ปิดตารางผู้ใช้ · ล็อกค่าตั้งตัวกันเวอร์ชัน (26 ต.ค.)
--
-- ทำไม: ตาราง app_users (รวมช่องรหัสผ่าน) อ่าน/เขียนได้ด้วย anon key ที่อยู่ในหน้าเว็บ · แอปตรวจรหัสผ่านในเบราว์เซอร์
--   · การจัดการผู้ใช้ไม่มีการตรวจสิทธิ์ที่เซิร์ฟเวอร์ · ค่าตั้ง client_build_guard แก้ได้จากภายนอก
-- วิธี: ฟังก์ชันฝั่งเซิร์ฟเวอร์ (security definer) ตรวจรหัสผ่าน + ออกโทเค็นเซสชัน · รายชื่อผู้ใช้อ่านผ่าน view ไม่มีรหัสผ่าน
--   · เพิ่ม/แก้/ลบผู้ใช้ผ่านฟังก์ชันที่ต้องใช้โทเค็นของ admin · รูปแบบ hash เดิม (sha256$salt$hex) ใช้ต่อได้ ไม่ต้องตั้งรหัสใหม่
--
-- ลำดับ (สำคัญ):
--   1. รันขั้นที่ 1 (เพิ่มอย่างเดียว ไม่กระทบแอปเดิม) → ขั้นที่ 2 ทดสอบ
--   2. merge + deploy แอปที่ล็อกอินผ่านฟังก์ชันนี้ → ทุกเครื่องอัปเดต (ยก min_build)
--   3. ขั้นที่ 3: ปิดตาราง app_users จาก anon (หลังจากนี้แอปเวอร์ชันเก่าล็อกอินไม่ได้)
--
-- วิธีใช้: Supabase → SQL Editor · รันทีละขั้น

-- ── ขั้นที่ 1: ติดตั้ง (รันทั้งก้อน) ───────────────────────────────────────────────────────────
create extension if not exists pgcrypto with schema extensions;
-- ตารางจริงยังไม่มีคอลัมน์นี้ (ตรวจ 28 ต.ค.) — ฟังก์ชันด้านล่างจดเวลาที่แก้รหัสผ่าน/ข้อมูลผู้ใช้
alter table public.app_users add column if not exists updated_at timestamptz not null default now();

create table if not exists public.app_sessions (
  token      text primary key,
  user_id    text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.app_sessions enable row level security; -- ไม่มี policy = anon อ่าน/เขียนตรงไม่ได้
revoke all on public.app_sessions from anon, authenticated;

-- รายชื่อผู้ใช้สำหรับแอป (ไม่มีรหัสผ่าน)
create or replace view public.app_users_public as
  select id, name, role, username, active from public.app_users;
grant select on public.app_users_public to anon, authenticated;

-- hash รูปแบบเดียวกับแอป: sha256$<salt>$hex(sha256("<salt>:<password>"))
create or replace function public.sjwd_hash_pw(p_password text, p_salt text default null)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare s text := coalesce(p_salt, encode(extensions.gen_random_bytes(8), 'hex'));
begin
  return 'sha256$' || s || '$' || encode(extensions.digest(s || ':' || p_password, 'sha256'), 'hex');
end $$;
revoke all on function public.sjwd_hash_pw(text, text) from public, anon, authenticated;

create or replace function public.sjwd_pw_ok(p_password text, p_stored text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  if coalesce(p_password, '') = '' or coalesce(p_stored, '') = '' then return false; end if;
  if p_stored like 'sha256$%' then
    return public.sjwd_hash_pw(p_password, split_part(p_stored, '$', 2)) = p_stored;
  end if;
  return p_stored = p_password; -- แถวเก่าที่ยังไม่เข้ารหัส — sjwd_login อัปเกรดให้หลังผ่าน
end $$;
revoke all on function public.sjwd_pw_ok(text, text) from public, anon, authenticated;

-- ล็อกอิน: คืนข้อมูลผู้ใช้ (ไม่มีรหัสผ่าน) + โทเค็นเซสชัน · ผิด = null
create or replace function public.sjwd_login(p_username text, p_password text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare u public.app_users; tok text;
begin
  select * into u from public.app_users
   where lower(trim(username)) = lower(trim(p_username)) and active
   order by id limit 1;
  if not found or not public.sjwd_pw_ok(p_password, u.password) then
    perform pg_sleep(0.5); -- ชะลอการเดารหัส
    return null;
  end if;
  if u.password not like 'sha256$%' then
    update public.app_users set password = public.sjwd_hash_pw(p_password), updated_at = now() where id = u.id;
  end if;
  delete from public.app_sessions where expires_at < now();
  tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.app_sessions (token, user_id, expires_at) values (tok, u.id, now() + interval '20 hours');
  return json_build_object('id', u.id, 'name', u.name, 'role', u.role, 'username', u.username, 'active', u.active, 'token', tok);
end $$;
grant execute on function public.sjwd_login(text, text) to anon, authenticated;

create or replace function public.sjwd_logout(p_token text)
returns void language sql security definer set search_path = public as $$
  delete from public.app_sessions where token = p_token;
$$;
grant execute on function public.sjwd_logout(text) to anon, authenticated;

-- โทเค็นนี้เป็นของ admin ที่ยังใช้งานอยู่ไหม
create or replace function public.sjwd_admin_of(p_token text)
returns text language sql security definer set search_path = public as $$
  select u.id from public.app_sessions s join public.app_users u on u.id = s.user_id
   where s.token = p_token and s.expires_at > now() and u.active and u.role = 'admin';
$$;
revoke all on function public.sjwd_admin_of(text) from public, anon, authenticated;

-- เพิ่ม/แก้ผู้ใช้ (admin) · password ว่าง = คงรหัสเดิม · ส่งรหัสจริงมา ฐานข้อมูล hash ให้
create or replace function public.sjwd_admin_save_user(p_token text, p_id text, p_name text, p_role text,
  p_username text, p_active boolean, p_password text default null)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare uid text := coalesce(nullif(trim(p_id), ''), 'u' || encode(extensions.gen_random_bytes(6), 'hex'));
begin
  if public.sjwd_admin_of(p_token) is null then raise exception 'SJWD_NOT_ADMIN' using errcode = '42501'; end if;
  if coalesce(trim(p_username), '') = '' or coalesce(trim(p_name), '') = '' then raise exception 'SJWD_BAD_USER'; end if;
  if not exists (select 1 from public.app_users where id = uid) and coalesce(p_password, '') = '' then
    raise exception 'SJWD_PASSWORD_REQUIRED';
  end if;
  insert into public.app_users (id, name, role, username, password, active)
  values (uid, trim(p_name), p_role, trim(p_username),
          case when coalesce(p_password, '') = '' then '' else public.sjwd_hash_pw(p_password) end, coalesce(p_active, true))
  on conflict (id) do update set
    name = excluded.name, role = excluded.role, username = excluded.username, active = excluded.active,
    password = case when coalesce(p_password, '') = '' then public.app_users.password else excluded.password end,
    updated_at = now();
  if coalesce(p_active, true) = false then delete from public.app_sessions where user_id = uid; end if;
  return json_build_object('id', uid);
end $$;
grant execute on function public.sjwd_admin_save_user(text, text, text, text, text, boolean, text) to anon, authenticated;

create or replace function public.sjwd_admin_delete_user(p_token text, p_id text)
returns void language plpgsql security definer set search_path = public as $$
declare me text := public.sjwd_admin_of(p_token);
begin
  if me is null then raise exception 'SJWD_NOT_ADMIN' using errcode = '42501'; end if;
  if me = p_id then raise exception 'SJWD_CANNOT_DELETE_SELF'; end if;
  delete from public.app_sessions where user_id = p_id;
  delete from public.app_users where id = p_id;
end $$;
grant execute on function public.sjwd_admin_delete_user(text, text) to anon, authenticated;

-- ค่าตั้งตัวกันเวอร์ชัน แก้ได้เฉพาะ SQL Editor (คำสั่งที่มาทาง API ถูกปฏิเสธ)
create or replace function public.sjwd_app_config_lock()
returns trigger language plpgsql as $$
begin
  if coalesce(new.id, old.id) = 'client_build_guard'
     and coalesce(nullif(current_setting('request.headers', true), ''), '') <> '' then
    raise exception 'SJWD_LOCKED_CONFIG' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists sjwd_app_config_lock on public.app_config;
create trigger sjwd_app_config_lock before insert or update or delete on public.app_config
  for each row execute function public.sjwd_app_config_lock();

-- ── ขั้นที่ 2: ทดสอบ (ไม่เปลี่ยนข้อมูลจริง — จบด้วย error เสมอ ฐานข้อมูลย้อนทุกอย่างเอง) ─────────────────
-- ต้องขึ้น "ผลทดสอบ: ผ่านครบ 6/6"
do $$
declare ok int := 0; r json; tok text;
begin
  insert into public.app_users (id, name, role, username, password, active)
  values ('__t_admin', 'ทดสอบ', 'admin', '__t_admin', public.sjwd_hash_pw('pw-OK-1'), true),
         ('__t_drv', 'ทดสอบ2', 'driver', '__t_drv', 'plain9', true);
  -- 1) รหัสผิด → null
  if public.sjwd_login('__t_admin', 'wrong') is null then ok := ok + 1; end if;
  -- 2) รหัสถูก → ได้โทเค็น และไม่มีรหัสผ่านในผลลัพธ์
  r := public.sjwd_login('__T_ADMIN', 'pw-OK-1'); tok := r->>'token';
  if tok is not null and r->>'password' is null then ok := ok + 1; end if;
  -- 3) แถวเก่าไม่เข้ารหัส → ล็อกอินได้ และถูกอัปเกรดเป็น hash
  r := public.sjwd_login('__t_drv', 'plain9');
  if r is not null and (select password from public.app_users where id = '__t_drv') like 'sha256$%' then ok := ok + 1; end if;
  -- 4) admin แก้ผู้ใช้ได้ (รหัสว่าง = คงเดิม)
  perform public.sjwd_admin_save_user(tok, '__t_drv', 'ทดสอบ2', 'driver', '__t_drv', true, null);
  if public.sjwd_login('__t_drv', 'plain9') is not null then ok := ok + 1; end if;
  -- 5) โทเค็นผิด → แก้ไม่ได้
  begin
    perform public.sjwd_admin_save_user('bad', '__t_x', 'x', 'admin', '__t_x', true, 'x');
  exception when others then if sqlerrm like 'SJWD_NOT_ADMIN%' then ok := ok + 1; end if;
  end;
  -- 6) view ไม่มีช่องรหัสผ่าน
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'app_users_public' and column_name = 'password') then ok := ok + 1; end if;
  raise exception 'ผลทดสอบ: %', case when ok = 6 then 'ผ่านครบ 6/6' else 'ไม่ผ่าน ' || ok || '/6' end;
end $$;

-- ── ขั้นที่ 3: ปิดตาราง app_users จาก anon (รันหลังทุกเครื่องเป็นแอปเวอร์ชันใหม่) ─────────────────────────
-- drop policy if exists "allow all app_users" on public.app_users;
-- revoke all on public.app_users from anon, authenticated;

-- ── ถอดออก ───────────────────────────────────────────────────────────────────────────────
-- drop trigger if exists sjwd_app_config_lock on public.app_config;
-- (ถ้ารันขั้นที่ 3 แล้วต้องการย้อน) create policy "allow all app_users" on public.app_users for all to anon, authenticated using (true) with check (true);
--   grant select, insert, update, delete on public.app_users to anon, authenticated;
