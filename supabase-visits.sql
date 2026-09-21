-- visits — "รอบที่รถมาเยือนยาร์ด" ที่ปิดแล้ว: 1 แถวต่อ 1 รอบ เป็นของยาร์ดต้นทาง
-- (แยกยาร์ด แยกงาน — ขั้นที่ 1: รอบที่ปิดแล้วกลายเป็นแถวจริง แถวสดของรถยังเป็นแบบเดิม)
-- รันครั้งเดียวใน Supabase Dashboard → SQL Editor → Run
-- ถ้ายังไม่รัน แอปยังทำงานได้ แต่รอบที่ปิดจะเห็นเฉพาะบนเครื่องที่ปิดรอบเท่านั้น

create table if not exists public.visits (
  id           text primary key,            -- "<vin>#<round>"
  vin          text not null,
  round        integer not null,
  site_id      text,                        -- Site.id ของยาร์ดที่รอบนี้เกิดขึ้น (ไม่ใส่ FK เพื่อกัน 23503 silent-fail)
  cells        jsonb not null default '{}', -- ช่องของรอบนี้ (วันที่เข้า/ออก · Grouping · PDI/PM …) + รุ่น/สี
  history      jsonb not null default '[]', -- ประวัติการแก้ไขจนถึงตอนรถออก
  closed_at    timestamptz,                 -- เวลาที่รอบถูกปิด
  gate_out_at  timestamptz,                 -- เวลาที่รถออกจากยาร์ด
  updated_at   timestamptz default now()
);

create index if not exists visits_site_idx on public.visits (site_id);
create index if not exists visits_vin_idx on public.visits (vin);

alter table public.visits enable row level security;

drop policy if exists "allow all visits" on public.visits;
create policy "allow all visits" on public.visits
  for all to anon, authenticated using (true) with check (true);
