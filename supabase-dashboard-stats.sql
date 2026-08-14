-- ══════════════════════════════════════════════════════════════════════════
-- dashboard_stats — เลขสรุปหน้า Dashboard ทั้งหน้า คำนวณบนเซิร์ฟเวอร์ (แบบ N4)
-- ทุกจอเรียกฟังก์ชันเดียวกัน → ได้เลขชุดเดียวกันเป๊ะ โดยไม่ต้องโหลดแถวมาเลย
-- รันครั้งเดียวใน Supabase Dashboard → SQL Editor → Run
-- (ตรรกะเป็น port เต็มรูปแบบของ deriveCarStatus ใน src/lib/carStatus.ts —
--  ตัวเดียวกับที่ in_yard_count ใช้ แต่คืนสถานะครบทุกตัว + ตาราง pivot)
-- ══════════════════════════════════════════════════════════════════════════

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

grant execute on function public.dashboard_stats(text, text[]) to anon, authenticated;
