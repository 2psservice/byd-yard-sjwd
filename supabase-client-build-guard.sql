-- กันแอปเวอร์ชันเก่าที่ค้างในเครื่อง "เขียน" ข้อมูล (อ่านได้ตามปกติ)
--
-- ทำไม: 20 ต.ค. 20:21 โน้ตบุ๊กที่เปิดแอปเวอร์ชันก่อน 3 ต.ค. (ค้างใน service worker) ย้ายแถวรถ 144 คันข้ามยาร์ดเอง
--   ในชื่อคนที่ล็อกอินค้าง · 15 ต.ค. มือถือเวอร์ชันเก่าล้างตำแหน่งรถ · แท็บ Edge เก่าดึงข้อมูลหนักจน error
-- วิธี: แอปตั้งแต่ PR "x-sjwd-build" แนบหัว x-sjwd-build = เวลา build (ms) ทุกคำขอ
--   ตัวกันระดับคำสั่ง (statement trigger) บนตารางที่หน้างานเขียน ตรวจหัวนี้:
--     · ไม่มีหัว / เลขต่ำกว่า min_build → โหมดเฝ้าดู (enforce=false): ให้ผ่าน + จดลง client_build_log
--                                          โหมดล็อก (enforce=true): ปฏิเสธคำสั่งนั้น (error SJWD_OLD_APP)
--     · คำสั่งที่ไม่ได้มาทาง API (SQL Editor / สคริปต์แอดมิน) ไม่มี request.headers → ไม่ตรวจ
--   ค่าตั้ง: app_config id = 'client_build_guard' → {"min_build": <ms>, "enforce": false|true}
--
-- ลำดับ (สำคัญ):
--   1. merge + deploy PR แอป (แนบหัว) ก่อน
--   2. รันไฟล์นี้ขั้นที่ 1–3 (ติดตั้งในโหมดเฝ้าดู — ไม่บล็อกใคร) · ใส่ min_build = เวลา build ที่ deploy (Claude แจ้งเลข)
--   3. เฝ้าดู client_build_log 1–3 วัน ตามเครื่องเก่าให้อัปเดตจนไม่มีรายการใหม่
--   4. ขั้นที่ 5: เปิดล็อก (enforce = true)
--
-- วิธีใช้: Supabase → SQL Editor · รันทีละขั้น

-- ── ขั้นที่ 1: ติดตั้ง (โหมดเฝ้าดู) — รันทั้งก้อน ────────────────────────────────────────────
create table if not exists public.client_build_log (
  id    bigserial primary key,
  at    timestamptz not null default now(),
  tbl   text,
  op    text,
  build text,
  ua    text,
  ip    text
);
-- รหัสเครื่อง (แอปตั้งแต่ PR "x-sjwd-device" แนบหัวนี้ = app_heartbeats.device_id) — ติดตั้งแล้วรันขั้นที่ 1 ซ้ำได้
alter table public.client_build_log add column if not exists device text;
alter table public.client_build_log enable row level security;
drop policy if exists "client_build_log insert" on public.client_build_log;
create policy "client_build_log insert" on public.client_build_log for insert to anon, authenticated with check (true);
drop policy if exists "client_build_log read" on public.client_build_log;
create policy "client_build_log read" on public.client_build_log for select to anon, authenticated using (true);
create index if not exists client_build_log_at_idx on public.client_build_log (at);

insert into public.app_config (id, value)
values ('client_build_guard', '{"min_build": 0, "enforce": false}'::jsonb)
on conflict (id) do nothing;

create or replace function public.sjwd_client_build_guard()
returns trigger
language plpgsql
as $$
declare
  h       jsonb;
  b       text;
  cfg     jsonb;
  minb    bigint;
  enforce boolean;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    h := null;
  end;
  if h is null then
    return null; -- ไม่ได้มาทาง API (SQL Editor / สคริปต์) — ไม่ตรวจ
  end if;

  select value into cfg from public.app_config where id = 'client_build_guard';
  minb    := coalesce((cfg->>'min_build')::bigint, 0);
  enforce := coalesce((cfg->>'enforce')::boolean, false);

  b := h->>'x-sjwd-build';
  if b ~ '^[0-9]{13}$' and b::bigint >= minb then
    return null; -- แอปเวอร์ชันที่รับได้
  end if;

  if enforce then
    raise exception 'SJWD_OLD_APP: แอปเวอร์ชันเก่า (build %) ปิดแอปแล้วเปิดใหม่ให้อัปเดตก่อนใช้งาน', coalesce(b, 'ไม่มี')
      using errcode = 'P0001';
  end if;

  insert into public.client_build_log (tbl, op, build, ua, ip, device)
  values (tg_table_name, tg_op, b, h->>'user-agent', coalesce(h->>'cf-connecting-ip', h->>'x-real-ip', h->>'x-forwarded-for'), h->>'x-sjwd-device');
  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['tracking_rows', 'yard_units', 'visits', 'damages', 'station_checks', 'ops_queues'] loop
    execute format('drop trigger if exists sjwd_client_build_guard on public.%I', t);
    execute format('create trigger sjwd_client_build_guard before insert or update or delete on public.%I
                    for each statement execute function public.sjwd_client_build_guard()', t);
  end loop;
end $$;

-- ── ขั้นที่ 2: ทดสอบ (ไม่เปลี่ยนข้อมูลจริง — จบด้วย error เสมอ ฐานข้อมูลย้อนทุกอย่างเอง) ─────────────────────
-- ผลอยู่ในข้อความ error: ต้องขึ้น "ผลทดสอบ: ผ่านครบ 4/4"
do $$
declare ok int := 0;
begin
  update public.app_config set value = '{"min_build": 1792500000000, "enforce": true}'::jsonb where id = 'client_build_guard';

  -- 1) แอปไม่มีหัว (เวอร์ชันเก่า) → ต้องถูกปฏิเสธ
  perform set_config('request.headers', '{"user-agent":"test-old"}', true);
  begin
    update public.tracking_rows set updated_at = updated_at where vin = '__sjwd_guard_test__';
  exception when others then
    if sqlerrm like 'SJWD_OLD_APP%' then ok := ok + 1; end if;
  end;

  -- 2) เลข build ต่ำกว่า min → ต้องถูกปฏิเสธ
  perform set_config('request.headers', '{"x-sjwd-build":"1700000000000"}', true);
  begin
    update public.yard_units set updated_at = updated_at where vin = '__sjwd_guard_test__';
  exception when others then
    if sqlerrm like 'SJWD_OLD_APP%' then ok := ok + 1; end if;
  end;

  -- 3) เลข build ใหม่ → ต้องผ่าน
  perform set_config('request.headers', '{"x-sjwd-build":"1792600000000"}', true);
  begin
    update public.tracking_rows set updated_at = updated_at where vin = '__sjwd_guard_test__';
    ok := ok + 1;
  exception when others then null;
  end;

  -- 4) ไม่ได้มาทาง API (ไม่มี request.headers) → ต้องผ่าน
  perform set_config('request.headers', '', true);
  begin
    update public.visits set id = id where id = '__sjwd_guard_test__';
    ok := ok + 1;
  exception when others then null;
  end;

  raise exception 'ผลทดสอบ: %', case when ok = 4 then 'ผ่านครบ 4/4' else 'ไม่ผ่าน ' || ok || '/4' end;
end $$;

-- ── ขั้นที่ 3: ตั้ง min_build = เวลา build ของแอปที่ deploy (โหมดเฝ้าดู ยังไม่บล็อก) ───────────────────
-- แทน 0000000000000 ด้วยเลขที่ Claude แจ้ง
update public.app_config
set value = jsonb_build_object('min_build', 0000000000000, 'enforce', false), updated_at = now()
where id = 'client_build_guard'
returning value;

-- ── ขั้นที่ 4: ดูเครื่องเวอร์ชันเก่าที่ยังเขียนข้อมูล (อ่านอย่างเดียว — Claude อ่านเองได้ทาง API) ──────────────
select date_trunc('hour', l.at) as hour, l.tbl, coalesce(l.build, 'ไม่มีหัว') as build,
       coalesce(hb.user_name, l.device) as device, l.ua, l.ip, count(*)
from public.client_build_log l
left join public.app_heartbeats hb on hb.device_id = l.device
where l.at > now() - interval '3 days'
group by 1, 2, 3, 4, 5, 6
order by 1 desc;

-- ── ขั้นที่ 5: เปิดล็อก (หลังไม่มีรายการใหม่ใน client_build_log) ───────────────────────────────────
-- update public.app_config set value = jsonb_set(value, '{enforce}', 'true'), updated_at = now() where id = 'client_build_guard';

-- ── ถอดออก / ปิดชั่วคราว ───────────────────────────────────────────────────────────────────
-- ปิดล็อกทันที (ไม่ต้องถอด trigger):
--   update public.app_config set value = jsonb_set(value, '{enforce}', 'false') where id = 'client_build_guard';
-- ถอดทั้งหมด:
--   do $$ declare t text; begin foreach t in array array['tracking_rows','yard_units','visits','damages','station_checks','ops_queues'] loop
--     execute format('drop trigger if exists sjwd_client_build_guard on public.%I', t); end loop; end $$;
--   drop function if exists public.sjwd_client_build_guard();
