-- station_checks — "ช่องที่ใช้ร่วมกันต่อคัน" (PDI / RE-PDI / PM / Final check / ค่าวัด / สถานะตรวจ)
-- แยกข้อมูลรายยาร์ด ขั้นที่ 1 (ดู docs/site-separation-design.md §3.4):
--   ผลตรวจ PDI/PM/FINAL และค่าวัดเป็นของ "รถ" ไม่ใช่ของ "ยาร์ด" — ตอนนี้ยังอยู่ในช่องชีต
--   (tracking_rows.cells) ซึ่งจะถูกแยกตามยาร์ดในขั้นที่ 3 ตารางนี้เก็บค่าล่าสุดต่อ (vin, key)
--   ให้ทุกยาร์ดใช้ร่วมกัน แอปเขียนสองทาง (ชีต + ตารางนี้) ตั้งแต่ขั้นที่ 1 การอ่านยังมาจากชีต
-- รันครั้งเดียวใน Supabase Dashboard → SQL Editor → Run (รันซ้ำได้ ไม่ทับค่าที่แอปเขียนแล้ว)
-- ตารางเดิมไม่ถูกแตะ — ย้อนกลับ = ไม่ต้องทำอะไร (แอปรุ่นก่อนไม่รู้จักตารางนี้)

create table if not exists public.station_checks (
  vin        text not null,
  key        text not null,                 -- ชื่อช่องชีตเดิม เช่น 'PDI', 'PM3', 'Final check date', '% SOC'
  value      text not null default '',
  at         timestamptz,                   -- เวลาที่ค่านี้ถูกบันทึก (จาก history ของแถว ถ้ามี)
  by         text,                          -- ผู้บันทึก
  src        text,                          -- 'scan' (สถานี) · 'admin' · 'import' · 'backfill'
  site_id    text,                          -- ยาร์ดที่บันทึก (เพื่อแสดง/รายงาน ไม่ใช้แยกข้อมูล)
  updated_at timestamptz default now(),
  primary key (vin, key)
);

create index if not exists station_checks_vin_idx on public.station_checks (vin);
create index if not exists station_checks_updated_idx on public.station_checks (updated_at);

alter table public.station_checks enable row level security;
drop policy if exists "allow all station_checks" on public.station_checks;
create policy "allow all station_checks" on public.station_checks
  for all to anon, authenticated using (true) with check (true);

-- ── backfill จากช่องชีตปัจจุบัน (รถที่ยังไม่ถูกลบ) ─────────────────────────────────
-- เฉพาะช่องที่ใช้ร่วมกัน (SHARED_VIN_KEYS ใน src/lib/stationChecks.ts) และมีค่า
-- on conflict do nothing: ถ้าแอปเขียนค่าใหม่กว่าลงตารางไปแล้ว ไม่ทับ
insert into public.station_checks (vin, key, value, at, by, src, site_id)
select t.vin, c.key, c.value, t.updated_at, null, 'backfill', t.site
from public.tracking_rows t
cross join lateral jsonb_each_text(coalesce(t.cells, '{}'::jsonb)) as c(key, value)
where t.deleted_at is null
  and btrim(c.value) <> ''
  and c.key in (
    'Status', 'Vin Of Status', 'Final Status', 'Final check date', 'OK date', 'PIC (PDI)',
    '% SOC', 'Tire Pressure', 'Aging PM',
    'Tire Pressure FL', 'Tire Pressure FR', 'Tire Pressure RL', 'Tire Pressure RR',
    'Mileage', 'Voltage of 12V',
    'PDI', 'RE PDI  Date #1', 'RE PDI  Date #2', 'RE PDI  Date #3', 'RE PDI  Date #4',
    'RE PDI  Date #5', 'RE PDI  Date #6', 'RE PDI  Date #7', 'RE PDI  Date #8',
    'PM1', 'PM2', 'PM3', 'PM4', 'PM5', 'PM6', 'PM7', 'PM8', 'PM9', 'PM10',
    'PM11', 'PM12', 'PM13', 'PM14', 'PM15'
  )
on conflict (vin, key) do nothing;

-- ── ตรวจยอดหลัง backfill ───────────────────────────────────────────────────────
-- select count(*) as rows, count(distinct vin) as vins, src, count(*) filter (where value = '') as blanks
--   from public.station_checks group by src;
