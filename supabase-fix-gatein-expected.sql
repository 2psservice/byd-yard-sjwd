-- ซ่อมรถที่ Gate-in แล้วแต่ units ค้าง EXPECTED (มีช่อง WCL แต่สถานะ/เวลา Gate-in หาย) — ไม่ขึ้น WCL บนจอ
--
-- ต้นเหตุ: ปุ่ม Confirm Gate-in เขียนสองครั้งพร้อมกัน — importUnits (EXPECTED, ไม่แตะช่อง) กับ gateIn (PARKED+WCL+เวลา)
-- ถ้าอันแรกถึงคลาวด์ทีหลัง สถานะ/เวลา Gate-in ถูกทับ เหลือช่อง WCL กับ EXPECTED (15 ต.ค. 11:40 มี 97 คัน, เก่าสุด 16 ก.ย.)
-- แก้โค้ดใน PR #587 — จนกว่าจะ deploy อาจเกิดใหม่ได้ รันไฟล์นี้ซ้ำได้ (แตะเฉพาะคันที่ยังผิด)
--
-- ค่าที่ตั้ง = เหมือน gateIn ปกติ: PARKED · gate_in_at/gate_in_by จากแถวติดตาม (เวลา/ผู้ยิงจริง) · inspected = true
-- เงื่อนไข: units EXPECTED + มีช่อง · แถวติดตาม Car Status = In Yard + มี Gate In Time (มาจากปุ่ม Gate-in เท่านั้น)
-- ไม่แตะช่องจอด · ตัวกัน units_guard_stale_write ไม่บล็อก (EXPECTED → PARKED)
-- ถ้าสลับไป yard_units แล้ว: เปลี่ยน public.units เป็น public.yard_units ในทั้งสองคำสั่ง (และ join ด้วย vin เหมือนเดิม)
--
-- วิธีใช้: Supabase → SQL Editor · รันทีละขั้น

-- ── ขั้นที่ 1: ดูก่อน (อ่านอย่างเดียว) — จำนวนแถวที่ขึ้น = จำนวนที่จะซ่อม ─────────────────────
select u.vin, u.site_id, u.block, u."row", u.slot,
       to_timestamp((t.cells->>'Gate In Time')::bigint / 1000.0) as gate_in_at,
       t.cells->>'Gate In Inspector' as gate_in_by
from public.units u
join public.tracking_rows t on t.vin = u.vin
where u.status = 'EXPECTED'
  and u.block is not null
  and t.cells->>'Car Status' = 'In Yard'
  and (t.cells->>'Gate In Time') ~ '^[0-9]{12,}$'
order by gate_in_at desc;

-- ── ขั้นที่ 2: ซ่อม — ผลคือรายชื่อ VIN ที่ซ่อมแล้ว ──────────────────────────────────────────
update public.units u
set status     = 'PARKED',
    gate_in_at = to_timestamp((t.cells->>'Gate In Time')::bigint / 1000.0),
    gate_in_by = coalesce(t.cells->>'Gate In Inspector', u.gate_in_by),
    inspected  = true
from public.tracking_rows t
where t.vin = u.vin
  and u.status = 'EXPECTED'
  and u.block is not null
  and t.cells->>'Car Status' = 'In Yard'
  and (t.cells->>'Gate In Time') ~ '^[0-9]{12,}$'
returning u.vin, u.block, u."row", u.slot, u.status;
