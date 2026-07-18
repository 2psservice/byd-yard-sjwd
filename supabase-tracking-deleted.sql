-- tracking_rows.deleted_at — soft-delete tombstone.
-- แก้ปัญหา "ลบรถออกจาก Unit List แล้วเด้งกลับมา": เดิมการลบเป็น hard delete
-- เครื่องอื่นที่ยัง cache แถวนั้นไว้จะอัปโหลดกลับขึ้น cloud ตอน sync รอบใหญ่.
-- ตอนนี้การลบจะเขียน deleted_at ไว้เป็น tombstone แทน ทุกเครื่องจึงรับรู้ว่าถูกลบ
-- และจะไม่คืนชีพแถวนั้นอีก. Tombstone เก่ากว่า 30 วันจะถูกล้างทิ้งอัตโนมัติจากฝั่งแอป.
-- รันครั้งเดียวใน Supabase Dashboard → SQL Editor → Run

alter table public.tracking_rows
  add column if not exists deleted_at timestamptz;

-- ดัชนีช่วยให้การกรอง/ล้าง tombstone เร็วขึ้น (ไม่บังคับ แต่แนะนำ)
create index if not exists tracking_rows_deleted_at_idx
  on public.tracking_rows (deleted_at)
  where deleted_at is not null;
