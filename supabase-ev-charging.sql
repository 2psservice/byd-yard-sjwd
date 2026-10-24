-- ev_charges — งานชาร์จแบต EV (สถานี EV Charging ใน Ops Scan + เมนู EV Charging ของแอดมิน)
-- 1 แถว = รถ 1 คัน 1 รอบชาร์จ: รูปเลขวิน · รูป/เปอร์เซ็นต์ก่อนชาร์จ · รูป/เปอร์เซ็นต์หลังชาร์จ · เวลาเริ่ม/จบ
-- รันครั้งเดียวใน Supabase Dashboard → SQL Editor → Run (รันซ้ำได้ ไม่ทับข้อมูลที่แอปเขียนแล้ว)
-- เป็นตารางใหม่ ไม่แตะตารางเดิม · ถ้ายังไม่รัน สถานีจะแจ้งว่าบันทึกขึ้นระบบไม่ได้ และเก็บไว้ในเครื่องก่อน

create table if not exists public.ev_charges (
  id            text primary key,            -- "<vin>#<เวลาเริ่ม base36>"
  site_id       text,                        -- ยาร์ดที่ชาร์จ (Site.id)
  vin           text not null,
  model         text not null default '',
  color         text not null default '',
  from_yard     text not null default '',    -- ช่อง From ของรถ (ตามไฟล์ Excel ที่ใช้อยู่)
  remark        text not null default '',
  vin_photo     text not null default '',    -- รูปเลขวิน (Export Label) — ลิงก์รูป
  before_photo  text not null default '',
  before_pct    integer,                     -- เปอร์เซ็นต์ที่บันทึกจริง (พนักงานแก้ได้)
  before_ai     integer,                     -- ไม่ใช้แล้ว (เลิกใช้ AI อ่าน % — พนักงานพิมพ์เอง) คงไว้ให้ตรงกับตารางที่สร้างแล้ว
  before_at     timestamptz,
  before_by     text not null default '',
  after_photo   text not null default '',
  after_pct     integer,
  after_ai      integer,                     -- ไม่ใช้แล้ว เหมือน before_ai
  after_at      timestamptz,                 -- ว่าง = ยังชาร์จอยู่
  after_by      text not null default '',
  updated_at    timestamptz default now()
);

create index if not exists ev_charges_site_before_idx on public.ev_charges (site_id, before_at);
create index if not exists ev_charges_vin_idx on public.ev_charges (vin);

alter table public.ev_charges enable row level security;
drop policy if exists "allow all ev_charges" on public.ev_charges;
create policy "allow all ev_charges" on public.ev_charges
  for all to anon, authenticated using (true) with check (true);

notify pgrst, 'reload schema';

-- ผลตรวจ (คำสั่งสุดท้าย — Supabase SQL Editor แสดงผลเฉพาะคำสั่งสุดท้าย): ต้องได้ table_ready = true
select exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'ev_charges') as table_ready,
       (select count(*) from public.ev_charges) as rows;
