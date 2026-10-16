-- app_heartbeats — แต่ละเครื่องรายงานว่ารันแอปเวอร์ชัน (build) ไหน · ใช้ตามหาเครื่องที่ยังไม่อัปเดต
-- แอปเขียน (upsert ตาม device_id) ตอนล็อกอิน / เปลี่ยนยาร์ด / ทุก 15 นาทีที่เปิดอยู่ — ดู src/lib/heartbeat.ts
-- ยังไม่รันไฟล์นี้ = แอปเขียนไม่ได้แบบเงียบ ไม่กระทบงาน · รันซ้ำได้
-- วิธีใช้: Supabase → SQL Editor → รัน "ขั้นที่ 1" ทั้งก้อน (ครั้งเดียว) · ขั้นที่ 2 คือคำสั่งดูผล รันเมื่อไหร่ก็ได้

-- ── ขั้นที่ 1: สร้างตาราง ─────────────────────────────────────────────────────────────
create table if not exists public.app_heartbeats (
  device_id  text primary key,
  user_id    text,
  user_name  text,
  site_id    text,
  build      text not null,
  user_agent text,
  standalone boolean,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);
create index if not exists app_heartbeats_last_seen_idx on public.app_heartbeats (last_seen desc);

-- เวลาจากเซิร์ฟเวอร์เสมอ (นาฬิกามือถือเพี้ยนได้) · first_seen ไม่ถูกทับตอนอัปเดต
create or replace function public.app_heartbeats_touch()
returns trigger language plpgsql as $$
begin
  new.last_seen := now();
  if tg_op = 'UPDATE' then new.first_seen := old.first_seen; end if;
  return new;
end;
$$;
drop trigger if exists app_heartbeats_touch on public.app_heartbeats;
create trigger app_heartbeats_touch before insert or update on public.app_heartbeats
  for each row execute function public.app_heartbeats_touch();

-- RLS แบบเดียวกับตารางอื่นของแอป (allow-all ผ่าน anon)
alter table public.app_heartbeats enable row level security;
drop policy if exists "allow all app_heartbeats" on public.app_heartbeats;
create policy "allow all app_heartbeats" on public.app_heartbeats
  for all to anon, authenticated using (true) with check (true);

-- ── ขั้นที่ 2: ใครยังไม่อัปเดต (รันเมื่อไหร่ก็ได้) ─────────────────────────────────────────
-- build ล่าสุด = build ที่ "ปรากฏครั้งแรก" ใหม่ที่สุด (build ใหม่ย่อมเริ่มรายงานทีหลัง build เก่าเสมอ — ไม่หลงเพราะเครื่องเก่าเพิ่งรายงาน)
-- เครื่องที่ใช้งานใน 3 วันล่าสุด เรียงเครื่องที่ยังไม่อัปเดตก่อน
with latest as (select build from public.app_heartbeats group by build order by min(first_seen) desc limit 1)
select h.user_name, h.site_id, h.build,
       (h.build = (select build from latest)) as up_to_date,
       to_char(h.last_seen at time zone 'Asia/Bangkok', 'DD Mon HH24:MI') as last_seen_th,
       case when h.user_agent ilike '%android%' then 'Android' when h.user_agent ilike '%iphone%' or h.user_agent ilike '%ipad%' then 'iOS' else 'คอม/อื่นๆ' end as device,
       h.standalone as installed_app,
       h.device_id
from public.app_heartbeats h
where h.last_seen > now() - interval '3 days'
order by up_to_date, h.last_seen desc;
