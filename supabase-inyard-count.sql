-- ══════════════════════════════════════════════════════════════════════════
-- ยอด "In Yard" นับบนคลาวด์ที่เดียว — ทุกเครื่องแสดงเลขเดียวกันเสมอ
-- รันไฟล์นี้ครั้งเดียวใน Supabase Dashboard → SQL Editor → Run
--
-- ตรรกะเป็น port ของ deriveCarStatus (src/lib/carStatus.ts) เฉพาะส่วนที่ตัดสินว่า
-- "รถอยู่ในลานหรือไม่" — In Yard = ไม่ใช่ Pre Gate-in / Pre Gate-out / Preload /
-- Gate-out (Total loss นับว่าอยู่ในลาน: รถ write-off แต่ยังจอดอยู่จริง)
-- ══════════════════════════════════════════════════════════════════════════

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
$$;

grant execute on function public.in_yard_count(text, text[]) to anon, authenticated;
