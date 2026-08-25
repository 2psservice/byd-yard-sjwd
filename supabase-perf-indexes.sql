-- ═══════════════════════════════════════════════════════════════════════════
-- แก้ "canceling statement due to statement timeout" (SQLSTATE 57014)
-- รันครั้งเดียวใน Supabase Dashboard → SQL Editor → Run
--
-- อาการ: Postgres error ~77,000 ครั้ง/วัน (เกือบทุก request ที่ยิงไปล้มเหลว)
-- Success rate ตกเหลือ ~26%
--
-- สาเหตุ: ตารางหลัก 2 ตัวไม่มีดัชนี (index) ตรงกับคำสั่งที่แอปยิงถี่ที่สุด
-- ฐานข้อมูลจึงต้องไล่อ่านทั้งตารางทุกครั้ง พอเครื่องหน้างานเปิดพร้อมกันหลาย
-- เครื่อง (แต่ละเครื่องยิงทุก 1 นาที) เครื่อง micro จึงอ่านไม่ทันใน 8 วินาที
-- แล้วโดนตัดทิ้งเป็น timeout
--
-- CONCURRENTLY = สร้างดัชนีโดยไม่ล็อกตาราง แอปใช้งานต่อได้ระหว่างสร้าง
-- (ถ้า SQL Editor ไม่ยอมรับ CONCURRENTLY ให้ตัดคำนี้ออก แล้วรันช่วงที่ไม่มีคนใช้)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) tracking_rows.updated_at ───────────────────────────────────────────
-- ตัวที่หนักที่สุด: ทุกเครื่องยิง "ขอแถวที่เปลี่ยนตั้งแต่เวลา X" ทุก 60 วินาที
--   select ... from tracking_rows where updated_at > $1 order by vin limit 1000
-- ไม่มีดัชนี → ต้องอ่านทั้งตาราง (หมื่นกว่าแถว พร้อมคอลัมน์ jsonb ก้อนใหญ่)
-- ทุกนาที ต่อเครื่อง ทั้งที่ผลลัพธ์ปกติคือ 0 แถว
create index concurrently if not exists tracking_rows_updated_at_idx
  on public.tracking_rows (updated_at);

-- ── 2) tracking_rows: นับจำนวนรถที่ยังไม่ถูกลบ ────────────────────────────
-- แอปนับ "cloud มีกี่แถว" ทุกนาที ด้วย count(*) where deleted_at is null
-- ดัชนีเดิมที่มีอยู่ (tracking_rows_deleted_at_idx) เป็น partial แบบ
-- "where deleted_at IS NOT NULL" ซึ่งเป็นด้านตรงข้ามพอดี จึงใช้กับคำสั่งนี้ไม่ได้
create index concurrently if not exists tracking_rows_live_idx
  on public.tracking_rows (vin)
  where deleted_at is null;

-- ── 3) tracking_rows: ดัชนีของ "Location yard" ในคอลัมน์ jsonb ───────────
-- เครื่องใหม่เปิดครั้งแรกจะดึงเฉพาะยาร์ดปัจจุบัน:
--   select ... where cells->>'Location yard' = $1 order by vin
-- ค่าใน jsonb ใช้ดัชนีปกติไม่ได้ ต้องทำ expression index ให้ตรงรูปแบบที่ยิง
create index concurrently if not exists tracking_rows_location_yard_idx
  on public.tracking_rows ((cells->>'Location yard'))
  where deleted_at is null;

-- ── 4) units: รถที่ยังอยู่ในลาน ───────────────────────────────────────────
-- ตาราง units เก็บรถที่เคยผ่านลานทั้งหมด (รวม DEPARTED 20,000+ แถว) แต่ทุก
-- คำสั่งที่แอปใช้จริงถามเฉพาะรถที่ยังอยู่:
--   select ... from units where status <> 'DEPARTED' and site_id = $1 order by vin
-- partial index ตัด DEPARTED ออกตั้งแต่ต้น → ดัชนีเล็กและตรงกับงานที่ใช้จริง
create index concurrently if not exists units_active_site_vin_idx
  on public.units (site_id, vin)
  where status <> 'DEPARTED';

-- ── 5) damages.vin ────────────────────────────────────────────────────────
-- การดึงรถพร้อม defect ใช้ join จาก damages กลับมาที่ vin
-- ถ้ายังไม่มีดัชนีนี้ ทุกครั้งที่ดึงรถจะไล่อ่านตาราง damages ทั้งตาราง
create index concurrently if not exists damages_vin_idx
  on public.damages (vin);

-- ── 6) อัปเดตสถิติให้ตัววางแผนคำสั่ง เลือกใช้ดัชนีใหม่ทันที ────────────────
analyze public.tracking_rows;
analyze public.units;
analyze public.damages;

-- ═══════════════════════════════════════════════════════════════════════════
-- ตรวจผลหลังรัน (ควรเห็น "Index Scan" ไม่ใช่ "Seq Scan" และเวลาเป็นหลักมิลลิวินาที)
--
--   explain analyze
--   select vin from public.tracking_rows
--   where updated_at > now() - interval '2 minutes'
--   order by vin limit 1000;
--
-- ดูดัชนีทั้งหมดที่มีอยู่ตอนนี้:
--   select tablename, indexname from pg_indexes
--   where schemaname = 'public' order by tablename, indexname;
-- ═══════════════════════════════════════════════════════════════════════════
