-- ══════════════════════════════════════════════════════════════════════════
-- SJWD Yard Control — ตั้งค่า Supabase ครบชุดในไฟล์เดียว (รันซ้ำได้ ปลอดภัย)
-- รัน: Supabase Dashboard → SQL Editor → วางทั้งไฟล์ → Run
--
-- ⚠ ทนต่อ deadlock: ระหว่างที่อุปกรณ์หน้างานยังใช้ระบบอยู่ ตารางถูก query
-- ตลอดเวลา การแก้โครงสร้างต้องรอคิวล็อก — เวอร์ชันนี้แต่ละขั้นตอน "ล้มได้
-- อิสระ" (ขั้นที่ล็อกไม่ได้จะถูกข้าม ขั้นอื่นสำเร็จตามปกติ) ดูผลจากตาราง
-- สรุปท้ายไฟล์: ถ้ามีรายการ ✗ ให้กด Run ซ้ำจนขึ้น ✓ ครบทุกแถว
-- (ปกติ 1–2 รอบก็ครบ — ช่วงเงียบ ๆ เช่นพักเที่ยงจะผ่านรอบเดียว)
-- ══════════════════════════════════════════════════════════════════════════

-- อย่ารอคิวล็อกนานจน deadlock: 8 วินาทีไม่ได้ → ข้ามขั้นนั้น แล้วค่อย Run ซ้ำ
set lock_timeout = '8s';

-- 1) tracking_rows: คอลัมน์เสริมที่แอปใช้ ────────────────────────────────────
-- deleted_at = tombstone การลบ (ลบเครื่องเดียว หายทุกเครื่อง ไม่คืนชีพ)
do $$ begin
  execute 'alter table public.tracking_rows add column if not exists deleted_at timestamptz';
exception when lock_not_available or deadlock_detected then
  raise notice 'tracking_rows.deleted_at: ตารางถูกใช้งานอยู่ — กด Run ซ้ำอีกครั้ง';
end $$;

-- history = log การแก้ไขต่อ VIN (แท็บ Event)
do $$ begin
  execute 'alter table public.tracking_rows add column if not exists history jsonb';
exception when lock_not_available or deadlock_detected then
  raise notice 'tracking_rows.history: ตารางถูกใช้งานอยู่ — กด Run ซ้ำอีกครั้ง';
end $$;

-- site = ป้ายลานของแถว (แยกยอดต่อลาน)
do $$ begin
  execute 'alter table public.tracking_rows add column if not exists site text';
exception when lock_not_available or deadlock_detected then
  raise notice 'tracking_rows.site: ตารางถูกใช้งานอยู่ — กด Run ซ้ำอีกครั้ง';
end $$;

-- ดัชนีช่วยกรอง/ล้าง tombstone (ตารางหมื่นกว่าแถว สร้างไม่ถึงวินาที)
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'tracking_rows' and column_name = 'deleted_at') then
    execute 'create index if not exists tracking_rows_deleted_at_idx on public.tracking_rows (deleted_at) where deleted_at is not null';
  end if;
exception when lock_not_available or deadlock_detected then
  raise notice 'index deleted_at: ตารางถูกใช้งานอยู่ — กด Run ซ้ำอีกครั้ง';
end $$;

-- 2) app_config: ค่ากลางที่แชร์ทุกเครื่อง (default view, remark, ยอด In Yard กลาง)
do $$ begin
  execute 'create table if not exists public.app_config (
    id         text primary key,
    value      jsonb not null,
    updated_at timestamptz default now()
  )';
  execute 'alter table public.app_config enable row level security';
  execute 'drop policy if exists "allow all app_config" on public.app_config';
  execute 'create policy "allow all app_config" on public.app_config
    for all to anon, authenticated using (true) with check (true)';
exception when lock_not_available or deadlock_detected then
  raise notice 'app_config: ตารางถูกใช้งานอยู่ — กด Run ซ้ำอีกครั้ง';
end $$;

-- 2b) ops_queues: คิวงานหน้าลาน (Gate-in / PM / PDI / Wash) sync ข้ามเครื่อง ──
-- ไม่มีตารางนี้ = คิวที่สร้างตอน import ค้างอยู่แค่เครื่องแอดมิน — มือถือสแกน
-- จะไม่เห็นคิวเลย ("ในแอดมินขึ้น Pre Gate-in แต่ใน ops scan ไม่มีคิวงาน")
do $$ begin
  execute 'create table if not exists public.ops_queues (
    id         text primary key,
    site_id    text,
    name       text not null,
    created_at timestamptz default now(),
    created_by text,
    items      jsonb not null default ''[]'',
    updated_at timestamptz default now()
  )';
  execute 'alter table public.ops_queues add column if not exists type text';
  execute 'alter table public.ops_queues add column if not exists kind text';
  execute 'alter table public.ops_queues enable row level security';
  execute 'drop policy if exists "allow all ops_queues" on public.ops_queues';
  execute 'create policy "allow all ops_queues" on public.ops_queues
    for all to anon, authenticated using (true) with check (true)';
exception when lock_not_available or deadlock_detected then
  raise notice 'ops_queues: ตารางถูกใช้งานอยู่ — กด Run ซ้ำอีกครั้ง';
end $$;

-- 3) เปิด Realtime ให้ตารางหลัก (แก้ 1 เครื่อง เห็นพร้อมกันทุกเครื่อง) ────────
do $$ begin
  alter publication supabase_realtime add table public.tracking_rows;
exception
  when duplicate_object then null;
  when lock_not_available or deadlock_detected then
    raise notice 'realtime tracking_rows: ตารางถูกใช้งานอยู่ — กด Run ซ้ำอีกครั้ง';
end $$;
do $$ begin
  alter publication supabase_realtime add table public.units;
exception
  when duplicate_object then null;
  when lock_not_available or deadlock_detected then
    raise notice 'realtime units: ตารางถูกใช้งานอยู่ — กด Run ซ้ำอีกครั้ง';
end $$;
do $$ begin
  alter publication supabase_realtime add table public.damages;
exception
  when duplicate_object then null;
  when lock_not_available or deadlock_detected then
    raise notice 'realtime damages: ตารางถูกใช้งานอยู่ — กด Run ซ้ำอีกครั้ง';
end $$;
do $$ begin
  alter publication supabase_realtime add table public.sites;
exception
  when duplicate_object then null;
  when lock_not_available or deadlock_detected then
    raise notice 'realtime sites: ตารางถูกใช้งานอยู่ — กด Run ซ้ำอีกครั้ง';
end $$;
do $$ begin
  alter publication supabase_realtime add table public.app_users;
exception
  when duplicate_object then null;
  when lock_not_available or deadlock_detected then
    raise notice 'realtime app_users: ตารางถูกใช้งานอยู่ — กด Run ซ้ำอีกครั้ง';
end $$;

-- 4) ฟังก์ชันนับยอด In Yard บนคลาวด์ (เลขเดียวกันทุกเครื่อง) ─────────────────
-- ตรรกะเป็น port ของ deriveCarStatus (src/lib/carStatus.ts) เฉพาะส่วนที่ตัดสิน
-- ว่า "รถอยู่ในลานหรือไม่" — In Yard = ไม่ใช่ Pre Gate-in / Pre Gate-out /
-- Preload / Gate-out (Total loss นับว่าอยู่ในลาน: รถ write-off แต่ยังจอดอยู่จริง)
-- สร้างได้ก็ต่อเมื่อคอลัมน์จากข้อ 1 มีแล้ว (Postgres ตรวจ body ตอน create) —
-- ถ้ายังไม่มีจะข้ามพร้อมแจ้งเตือน กด Run ซ้ำหลังข้อ 1 ผ่านแล้วจะติดตั้งให้เอง
do $setup$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'tracking_rows' and column_name = 'deleted_at')
     or not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'tracking_rows' and column_name = 'site') then
    raise notice 'in_yard_count: ต้องได้คอลัมน์จากข้อ 1 ก่อน — กด Run ซ้ำอีกครั้ง';
    return;
  end if;
  execute $fn$
create or replace function public.in_yard_count(p_site_id text default null, p_names text[] default null)
returns integer
language sql
stable
as $$
with scoped as (
  select t.cells
  from public.tracking_rows t
  where t.deleted_at is null
    and coalesce(trim(t.cells->>'Vin'), '') <> ''
    and (
      p_site_id is null
      or t.site = p_site_id
      -- legacy rows with no site tag: match "Location yard" against the
      -- site's normalized name/code (same rule as rowInSite in the app)
      or (
        coalesce(t.site, '') = ''
        and p_names is not null
        and lower(regexp_replace(trim(coalesce(t.cells->>'Location yard', '')), '\s+', ' ', 'g')) = any (p_names)
      )
    )
),
derived as (
  select
    case
      -- write-off ยังจอดในลานจริง → นับ
      when c.vos ~* 'total\s*loss' then true
      -- แผนรับ ("แผนรับวันที่ 10/07/2026") ที่เลยกำหนดเกิน 2 วัน → ออกแล้ว
      when (not f.stamp_is_bare)
           and f.plan_dmy is not null
           and f.plan_dmy[2]::int between 1 and 12
           and f.plan_dmy[1]::int between 1 and 31
           and (f.plan_dmy[3]::int, f.plan_dmy[2]::int, f.plan_dmy[1]::int)
             < (extract(year  from current_date - 2)::int,
                extract(month from current_date - 2)::int,
                extract(day   from current_date - 2)::int)
        then false
      -- สแกนออกแล้ว (รอ flush หรือ flush แล้ว) → ไม่อยู่ในลานทั้งสองกรณี
      when c.explicit = 'Pre Gate-out' then false
      -- สตริงสถานีรุ่นเก่า ("PARKING PM · PM20", "PM · PM20 OK") = รถยังจอดอยู่
      when c.explicit ~* '^parking\s+\S' or c.explicit ~* '\s(ok|ng)$' then true
      -- สถานะที่ระบุตรง ๆ: อยู่ในลานถ้าไม่ใช่กลุ่มเข้า/ออก
      when c.explicit <> '' then c.explicit not in ('Pre Gate-in', 'Gate-out', 'Preload')
      -- ไม่มีสถานะ: มีวันที่ออกจริง (stamp หรือ Gate Out Date) → ออกแล้ว
      when f.stamp_is_bare or f.gdate_is_bare then false
      -- มีเลข grouping → Ready (อยู่ในลาน)
      when c.grp <> '' then true
      -- ยังไม่เคย gate-in → Pre Gate-in
      when c.gatein = '' or c.gatein = '—' then false
      -- ที่เหลือ = In Yard / Gate-in
      else true
    end as in_yard
  from scoped s
  cross join lateral (
    select
      trim(coalesce(s.cells->>'Car Status', ''))            as explicit,
      coalesce(s.cells->>'Gate Out time stamp', '')         as stamp,
      coalesce(s.cells->>'Gate Out Date', '')               as gdate,
      coalesce(s.cells->>'Vin Of Status', '')               as vos,
      trim(coalesce(s.cells->>'Grouping  Number', ''))      as grp,
      trim(coalesce(s.cells->>'Gate In (Rayong yard)', '')) as gatein
  ) c
  cross join lateral (
    select
      -- "เป็นวันที่ล้วน" (isGateOutStamp): ตัดตัวเลข/ตัวคั่น/ชื่อเดือน/am-pm/น
      -- แล้วไม่เหลืออะไร และมีตัวเลขอย่างน้อยหนึ่งตัว
      (c.stamp ~ '\d' and regexp_replace(lower(c.stamp),
        '(\d+|[/\-.:,]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|am|pm|น|\s)', '', 'g') = '') as stamp_is_bare,
      (c.gdate ~ '\d' and regexp_replace(lower(c.gdate),
        '(\d+|[/\-.:,]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|am|pm|น|\s)', '', 'g') = '') as gdate_is_bare,
      regexp_match(c.stamp, '(\d{1,2})/(\d{1,2})/(\d{4})') as plan_dmy
  ) f
)
select count(*)::int from derived where in_yard
$$
  $fn$;
  execute 'grant execute on function public.in_yard_count(text, text[]) to anon, authenticated';
exception when others then
  raise notice 'in_yard_count: % — กด Run ซ้ำอีกครั้ง', sqlerrm;
end $setup$;

-- 5) dashboard_stats — เลขสรุปหน้า Dashboard ทั้งหน้า คำนวณบนเซิร์ฟเวอร์ (แบบ N4)
-- ทุกจอเรียกฟังก์ชันเดียวกัน → การ์ดทุกใบ + ตาราง Summary ได้เลขชุดเดียวกันเป๊ะ
do $setup2$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'tracking_rows' and column_name = 'deleted_at')
     or not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'tracking_rows' and column_name = 'site') then
    raise notice 'dashboard_stats: ต้องได้คอลัมน์จากข้อ 1 ก่อน — กด Run ซ้ำอีกครั้ง';
    return;
  end if;
  execute $fn2$
create or replace function public.dashboard_stats(p_site_id text default null, p_names text[] default null)
returns jsonb
language sql
stable
as $$
with scoped as (
  select t.cells
  from public.tracking_rows t
  where t.deleted_at is null
    and coalesce(trim(t.cells->>'Vin'), '') <> ''
    and (
      p_site_id is null
      or t.site = p_site_id
      or (
        coalesce(t.site, '') = ''
        and p_names is not null
        and lower(regexp_replace(trim(coalesce(t.cells->>'Location yard', '')), '\s+', ' ', 'g')) = any (p_names)
      )
    )
),
f as (
  select
    trim(coalesce(s.cells->>'Car Status', ''))             as explicit,
    coalesce(s.cells->>'Gate Out time stamp', '')          as stamp,
    coalesce(s.cells->>'Gate Out Date', '')                as gdate,
    coalesce(s.cells->>'Vin Of Status', '')                as vos,
    trim(coalesce(s.cells->>'Grouping  Number', ''))       as grp,
    trim(coalesce(s.cells->>'Gate In (Rayong yard)', ''))  as gatein,
    trim(coalesce(s.cells->>'storage Yard', ''))           as storage,
    coalesce(s.cells->>'Location yard', '')                as loc,
    coalesce(s.cells->>'Final Status', '')                 as final_status,
    -- (Model || Model name || '—') with JS ||-semantics: empty string falls through
    coalesce(nullif(trim(coalesce(s.cells->>'Model', '')), ''),
             nullif(trim(coalesce(s.cells->>'Model name', '')), ''), '—') as model,
    case when coalesce(s.cells->>'Gate Out Time', '') ~ '^\d+$'
         then (s.cells->>'Gate Out Time')::numeric else 0 end as go_ms
  from scoped s
),
g as (
  select f.*,
    -- isGateOutStamp: strip date/time tokens; bare date left over = real gate-out
    (f.stamp ~ '\d' and regexp_replace(lower(f.stamp),
      '(\d+|[/\-.:,]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|am|pm|น|\s)', '', 'g') = '') as stamp_is_bare,
    (f.gdate ~ '\d' and regexp_replace(lower(f.gdate),
      '(\d+|[/\-.:,]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|am|pm|น|\s)', '', 'g') = '') as gdate_is_bare,
    regexp_match(f.stamp, '(\d{1,2})/(\d{1,2})/(\d{4})') as plan_dmy,
    regexp_match(f.stamp, '(\d{1,2})/(\d{1,2})/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?') as scan_m
  from f
),
h as (
  select g.*,
    -- Pre-Gate-out scan moment as Bangkok wall-clock (pastGateOutFlush):
    -- prefer the epoch-ms "Gate Out Time" cell, else parse the display stamp.
    -- (make_date(y,m,1) + (d-1) days rolls invalid days over like JS Date does)
    case
      when g.go_ms > 0 then (to_timestamp(g.go_ms / 1000.0) at time zone 'Asia/Bangkok')
      when g.scan_m is not null
           and g.scan_m[2]::int between 1 and 12 and g.scan_m[1]::int between 1 and 31 then
        make_date(g.scan_m[3]::int, g.scan_m[2]::int, 1)::timestamp
          + ((g.scan_m[1]::int - 1) * interval '1 day')
          + (coalesce(g.scan_m[4], '0')::int * interval '1 hour')
          + (coalesce(g.scan_m[5], '0')::int * interval '1 minute')
      else null
    end as scan_ts
  from g
),
d as (
  select h.*,
    case
      -- write-off เป็นข้อเท็จจริงถาวร ชนะทุกสถานะ
      when h.vos ~* 'total\s*loss' then 'Total loss'
      -- แผนรับที่เลยกำหนดเกิน 2 วัน = ถูกรับไปแล้ว
      when (not h.stamp_is_bare)
           and h.plan_dmy is not null
           and h.plan_dmy[2]::int between 1 and 12
           and h.plan_dmy[1]::int between 1 and 31
           and (h.plan_dmy[3]::int, h.plan_dmy[2]::int, h.plan_dmy[1]::int)
             < (extract(year  from (now() at time zone 'Asia/Bangkok')::date - 2)::int,
                extract(month from (now() at time zone 'Asia/Bangkok')::date - 2)::int,
                extract(day   from (now() at time zone 'Asia/Bangkok')::date - 2)::int)
        then 'Gate-out'
      -- สแกนออกแล้ว → เป็น Gate-out จริงเมื่อผ่าน 09:30 รอบแรกหลังสแกน
      when h.explicit = 'Pre Gate-out' then
        case when h.scan_ts is not null
              and (now() at time zone 'Asia/Bangkok') >=
                  (case when date_trunc('day', h.scan_ts) + interval '9 hours 30 minutes' <= h.scan_ts
                        then date_trunc('day', h.scan_ts) + interval '1 day 9 hours 30 minutes'
                        else date_trunc('day', h.scan_ts) + interval '9 hours 30 minutes' end)
             then 'Gate-out' else 'Pre Gate-out' end
      -- สตริงงานสถานีรุ่นเก่า = รถยังจอดอยู่
      when h.explicit ~* '^parking\s+\S' or h.explicit ~* '\s(ok|ng)$' then 'In Yard'
      when h.explicit <> '' then h.explicit
      -- ไม่มีสถานะ: วันที่ออกจริง (stamp/Gate Out Date) → ออกแล้ว
      when h.stamp_is_bare or h.gdate_is_bare then 'Gate-out'
      when h.grp <> '' then 'Ready'
      when h.gatein = '' or h.gatein = '—' then 'Pre Gate-in'
      when h.storage <> '' or h.loc ~* 'yard' then 'In Yard'
      else 'Gate-in'
    end as st
  from h
)
select jsonb_build_object(
  'total', (select count(*) from d),
  'cards', (select jsonb_build_object(
     -- การ์ด In Yard ใช้กฎเดียวกับ in_yard_count: ทุกสถานะที่ไม่ใช่กลุ่มเข้า/ออก
     'in_yard',        count(*) filter (where st not in ('Pre Gate-in', 'Pre Gate-out', 'Preload', 'Gate-out')),
     'pre_gate_in',    count(*) filter (where st = 'Pre Gate-in'),
     'gate_in',        count(*) filter (where st = 'Gate-in'),
     'parked',         count(*) filter (where st in ('In Yard', 'PDI', 'Ready', 'Total loss')),
     'pre_gate_out',   count(*) filter (where st = 'Pre Gate-out'),
     'preload',        count(*) filter (where st = 'Preload'),
     'waiting_repair', count(*) filter (where st not in ('Pre Gate-in', 'Pre Gate-out', 'Preload', 'Gate-out')
                                          and lower(final_status) like '%wait%'
                                          and lower(final_status) like '%repair%')
   ) from d),
  'status_breakdown', coalesce((select jsonb_agg(jsonb_build_object('st', st, 'n', n) order by n desc)
     from (select st, count(*) as n from d group by st) x), '[]'::jsonb),
  'model_mix', coalesce((select jsonb_agg(jsonb_build_object('model', model, 'n', n) order by n desc)
     from (select model, count(*) as n from d group by model) x), '[]'::jsonb),
  -- pivot ใช้กฎของ YardSummary: เฉพาะสถานะในลานที่รู้จัก (IN_YARD_STATUSES)
  'pivot_final', coalesce((select jsonb_agg(jsonb_build_object('model', model, 'value', v, 'n', n))
     from (select model, coalesce(nullif(trim(final_status), ''), '(ว่าง)') as v, count(*) as n
           from d where st in ('Gate-in', 'In Yard', 'Moving', 'PDI', 'Ready', 'Total loss')
           group by 1, 2) x), '[]'::jsonb),
  'pivot_vos', coalesce((select jsonb_agg(jsonb_build_object('model', model, 'value', v, 'n', n))
     from (select model, coalesce(nullif(trim(vos), ''), '(ว่าง)') as v, count(*) as n
           from d where st in ('Gate-in', 'In Yard', 'Moving', 'PDI', 'Ready', 'Total loss')
           group by 1, 2) x), '[]'::jsonb)
)
$$;
  $fn2$;
  execute 'grant execute on function public.dashboard_stats(text, text[]) to anon, authenticated';
exception when others then
  raise notice 'dashboard_stats: % — กด Run ซ้ำอีกครั้ง', sqlerrm;
end $setup2$;

-- 6) daily_stock — รายงานประจำวัน (ยกมา/เข้า/ออก/คงเหลือ) คำนวณบนเซิร์ฟเวอร์
do $setup3$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'tracking_rows' and column_name = 'deleted_at')
     or not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'tracking_rows' and column_name = 'site') then
    raise notice 'daily_stock: ต้องได้คอลัมน์จากข้อ 1 ก่อน — กด Run ซ้ำอีกครั้ง';
    return;
  end if;
  execute $fn3a$
create or replace function public.__sjwd_loose_date(s text)
returns date
language sql
immutable
as $$
  select case
    -- ISO: 2026-08-14
    when m1 is not null and m1[2]::int between 1 and 12 then
      (make_date(m1[1]::int, m1[2]::int, 1) + ((m1[3]::int - 1) * interval '1 day'))::date
    -- Excel short date: 20-May-26 / 20-May-2026
    when m2 is not null and mon.idx is not null then
      (make_date(case when length(m2[3]) = 2 then 2000 + m2[3]::int else m2[3]::int end, mon.idx, 1)
        + ((m2[1]::int - 1) * interval '1 day'))::date
    -- Thai day-first: 14/08/2026
    when m3 is not null and m3[2]::int between 1 and 12 then
      (make_date(m3[3]::int, m3[2]::int, 1) + ((m3[1]::int - 1) * interval '1 day'))::date
    else null
  end
  from (select
    regexp_match(trim(coalesce(s, '')), '^(\d{4})-(\d{1,2})-(\d{1,2})') as m1,
    regexp_match(trim(coalesce(s, '')), '^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})') as m2,
    regexp_match(trim(coalesce(s, '')), '^(\d{1,2})/(\d{1,2})/(\d{4})') as m3
  ) r
  cross join lateral (select array_position(array['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'],
    lower(coalesce(r.m2[2], ''))) as idx) mon
$$;
  $fn3a$;
  execute $fn3b$
create or replace function public.daily_stock(p_site_id text default null, p_names text[] default null, p_day date default null)
returns jsonb
language sql
stable
as $$
with args as (
  select coalesce(p_day, (now() at time zone 'Asia/Bangkok')::date) as day
),
scoped as (
  select t.cells
  from public.tracking_rows t
  where t.deleted_at is null
    and coalesce(trim(t.cells->>'Vin'), '') <> ''
    and (
      p_site_id is null
      or t.site = p_site_id
      or (
        coalesce(t.site, '') = ''
        and p_names is not null
        and lower(regexp_replace(trim(coalesce(t.cells->>'Location yard', '')), '\s+', ' ', 'g')) = any (p_names)
      )
    )
),
f as (
  select
    trim(coalesce(s.cells->>'Vin', ''))                    as vin,
    trim(coalesce(s.cells->>'Car Status', ''))             as explicit,
    coalesce(s.cells->>'Gate Out time stamp', '')          as stamp,
    coalesce(s.cells->>'Gate Out Date', '')                as gdate,
    coalesce(s.cells->>'Vin Of Status', '')                as vos,
    trim(coalesce(s.cells->>'Grouping  Number', ''))       as grp,
    trim(coalesce(s.cells->>'Gate In (Rayong yard)', ''))  as gatein,
    trim(coalesce(s.cells->>'storage Yard', ''))           as storage,
    coalesce(s.cells->>'Location yard', '')                as loc,
    -- DailyStock's modelOf prefers "Model name" FIRST (ต่างจาก Dashboard)
    coalesce(nullif(trim(coalesce(s.cells->>'Model name', '')), ''),
             nullif(trim(coalesce(s.cells->>'Model', '')), ''), '—') as model,
    coalesce(nullif(trim(coalesce(s.cells->>'Color', '')), ''), '—') as color,
    case when coalesce(s.cells->>'Gate In Time', '') ~ '^\d+$'
         then (s.cells->>'Gate In Time')::numeric else 0 end as gi_ms,
    case when coalesce(s.cells->>'Gate Out Time', '') ~ '^\d+$'
         then (s.cells->>'Gate Out Time')::numeric else 0 end as go_ms
  from scoped s
),
g as (
  select f.*,
    (f.stamp ~ '\d' and regexp_replace(lower(f.stamp),
      '(\d+|[/\-.:,]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|am|pm|น|\s)', '', 'g') = '') as stamp_is_bare,
    (f.gdate ~ '\d' and regexp_replace(lower(f.gdate),
      '(\d+|[/\-.:,]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|am|pm|น|\s)', '', 'g') = '') as gdate_is_bare,
    regexp_match(f.stamp, '(\d{1,2})/(\d{1,2})/(\d{4})') as plan_dmy,
    regexp_match(f.stamp, '(\d{1,2})/(\d{1,2})/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?') as scan_m
  from f
),
-- parseLooseDate (dayKey.ts) เป็น SQL: ISO / dd-Mon-yy / dd/mm/yyyy — คืน null
-- เมื่อไม่เข้ารูปแบบ (ไม่เดารูปแบบกำกวม). make_date(y,m,1)+(d-1) วัน = JS Date
-- rollover (31 ก.พ. → มี.ค.) เพื่อให้ตรงกับ new Date(y, m-1, d)
h as (
  select g.*,
    -- gate-in day: exact epoch stamp first, else parse the imported date
    case
      when g.gi_ms > 0 then (to_timestamp(g.gi_ms / 1000.0) at time zone 'Asia/Bangkok')::date
      else public.__sjwd_loose_date(g.gatein)
    end as gi,
    -- Pre-Gate-out scan moment (Bangkok wall clock) for the 09:30 flush rule
    case
      when g.go_ms > 0 then (to_timestamp(g.go_ms / 1000.0) at time zone 'Asia/Bangkok')
      when g.scan_m is not null
           and g.scan_m[2]::int between 1 and 12 and g.scan_m[1]::int between 1 and 31 then
        make_date(g.scan_m[3]::int, g.scan_m[2]::int, 1)::timestamp
          + ((g.scan_m[1]::int - 1) * interval '1 day')
          + (coalesce(g.scan_m[4], '0')::int * interval '1 hour')
          + (coalesce(g.scan_m[5], '0')::int * interval '1 minute')
      else null
    end as scan_ts,
    -- gate-out day: bare stamp → bare Gate Out Date → lapsed plan (embedded dmy)
    case
      when g.stamp_is_bare then public.__sjwd_loose_date(g.stamp)
      when g.gdate_is_bare then public.__sjwd_loose_date(g.gdate)
      when (not g.stamp_is_bare)
           and g.plan_dmy is not null
           and g.plan_dmy[2]::int between 1 and 12
           and g.plan_dmy[1]::int between 1 and 31
           and (g.plan_dmy[3]::int, g.plan_dmy[2]::int, g.plan_dmy[1]::int)
             < (extract(year  from (now() at time zone 'Asia/Bangkok')::date - 2)::int,
                extract(month from (now() at time zone 'Asia/Bangkok')::date - 2)::int,
                extract(day   from (now() at time zone 'Asia/Bangkok')::date - 2)::int)
        then make_date(g.plan_dmy[3]::int, g.plan_dmy[2]::int, 1) + ((g.plan_dmy[1]::int - 1) * interval '1 day')
      else null
    end::date as go
  from g
),
d as (
  select h.*,
    case
      when h.vos ~* 'total\s*loss' then 'Total loss'
      when (not h.stamp_is_bare)
           and h.plan_dmy is not null
           and h.plan_dmy[2]::int between 1 and 12
           and h.plan_dmy[1]::int between 1 and 31
           and (h.plan_dmy[3]::int, h.plan_dmy[2]::int, h.plan_dmy[1]::int)
             < (extract(year  from (now() at time zone 'Asia/Bangkok')::date - 2)::int,
                extract(month from (now() at time zone 'Asia/Bangkok')::date - 2)::int,
                extract(day   from (now() at time zone 'Asia/Bangkok')::date - 2)::int)
        then 'Gate-out'
      when h.explicit = 'Pre Gate-out' then
        case when h.scan_ts is not null
              and (now() at time zone 'Asia/Bangkok') >=
                  (case when date_trunc('day', h.scan_ts) + interval '9 hours 30 minutes' <= h.scan_ts
                        then date_trunc('day', h.scan_ts) + interval '1 day 9 hours 30 minutes'
                        else date_trunc('day', h.scan_ts) + interval '9 hours 30 minutes' end)
             then 'Gate-out' else 'Pre Gate-out' end
      when h.explicit ~* '^parking\s+\S' or h.explicit ~* '\s(ok|ng)$' then 'In Yard'
      when h.explicit <> '' then h.explicit
      when h.stamp_is_bare or h.gdate_is_bare then 'Gate-out'
      when h.grp <> '' then 'Ready'
      when h.gatein = '' or h.gatein = '—' then 'Pre Gate-in'
      when h.storage <> '' or h.loc ~* 'yard' then 'In Yard'
      else 'Gate-in'
    end as st
  from h
),
-- exclusions ตรงกับ DailyStockReport ทีละบรรทัด
e as (
  select d.*,
    case
      when d.st = 'Pre Gate-in' then 'undated'
      when d.st = 'Gate-out' and d.go is null then 'out_no_date'
      when d.gi is null and d.go is null then 'undated'
      else 'counted'
    end as bucket
  from d
),
c as (select e.*, (select day from args) as day from e where e.bucket = 'counted')
select jsonb_build_object(
  'day', (select day from args),
  'opening', (select count(*) from c where gi is not null and gi <= day - 1 and (go is null or go > day - 1)),
  'in_n',    (select count(*) from c where gi = day),
  'out_n',   (select count(*) from c where go = day),
  'stock_n', (select count(*) from c where gi is not null and gi <= day and (go is null or go > day)),
  'undated',     (select count(*) from e where bucket = 'undated'),
  'out_no_date', (select count(*) from e where bucket = 'out_no_date'),
  'in_list', coalesce((select jsonb_agg(jsonb_build_object('vin', vin, 'model', model, 'color', color, 'grouping', nullif(grp,'')) order by model, vin)
     from c where gi = day), '[]'::jsonb),
  'out_list', coalesce((select jsonb_agg(jsonb_build_object('vin', vin, 'model', model, 'color', color, 'grouping', nullif(grp,'')) order by model, vin)
     from c where go = day), '[]'::jsonb),
  'stock_list', coalesce((select jsonb_agg(jsonb_build_object('vin', vin, 'model', model, 'color', color, 'grouping', nullif(grp,'')) order by model, vin)
     from c where gi is not null and gi <= day and (go is null or go > day)), '[]'::jsonb),
  'stock_matrix', coalesce((select jsonb_agg(jsonb_build_object('model', model, 'color', color, 'n', n))
     from (select model, color, count(*) as n from c
           where gi is not null and gi <= day and (go is null or go > day)
           group by model, color) x), '[]'::jsonb)
)
$$;
  $fn3b$;
  execute 'grant execute on function public.daily_stock(text, text[], date) to anon, authenticated';
  execute 'grant execute on function public.__sjwd_loose_date(text) to anon, authenticated';
exception when others then
  raise notice 'daily_stock: % — กด Run ซ้ำอีกครั้ง', sqlerrm;
end $setup3$;

-- ── สรุปผล: ทุกแถวต้องขึ้น ✓ — ถ้ามี ✗ ให้กด Run ซ้ำอีกครั้ง ─────────────────
select item, case when ok then '✓ พร้อมใช้งาน' else '✗ ยังไม่สำเร็จ — กด Run ซ้ำ' end as status
from (values
  ('1. คอลัมน์ tracking_rows.deleted_at (ลบแล้วหายทุกเครื่อง)',
    exists (select 1 from information_schema.columns where table_schema='public' and table_name='tracking_rows' and column_name='deleted_at')),
  ('2. คอลัมน์ tracking_rows.history (ประวัติการแก้ไข)',
    exists (select 1 from information_schema.columns where table_schema='public' and table_name='tracking_rows' and column_name='history')),
  ('3. คอลัมน์ tracking_rows.site (แยกยอดต่อลาน)',
    exists (select 1 from information_schema.columns where table_schema='public' and table_name='tracking_rows' and column_name='site')),
  ('4. ตาราง app_config (ค่ากลางแชร์ทุกเครื่อง)',
    exists (select 1 from information_schema.tables where table_schema='public' and table_name='app_config')),
  ('5. Realtime: tracking_rows (แก้ 1 เครื่องเห็นทุกเครื่อง)',
    exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='tracking_rows')),
  ('6. Realtime: units (ผังลานอัปเดตทุกเครื่อง)',
    exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='units')),
  ('7. Realtime: damages / sites / app_users',
    (select count(*) from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in ('damages','sites','app_users')) = 3),
  ('8. ฟังก์ชัน in_yard_count (ยอดกลางเลขเดียวทุกจอ)',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='in_yard_count')),
  ('9. ตาราง ops_queues + type/kind (คิวงานถึงมือถือสแกนทุกเครื่อง)',
    (select count(*) from information_schema.columns where table_schema='public' and table_name='ops_queues' and column_name in ('id','type','kind')) = 3),
  ('10. ฟังก์ชัน dashboard_stats (Dashboard ทั้งหน้าเลขชุดเดียวทุกจอ)',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='dashboard_stats')),
  ('11. ฟังก์ชัน daily_stock (รายงานประจำวันเลขชุดเดียวทุกจอ)',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='daily_stock'))
) t(item, ok)
order by item;
