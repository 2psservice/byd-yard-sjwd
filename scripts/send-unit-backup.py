#!/usr/bin/env python3
"""Nightly backup, part 2 of 2: zip the yard CSVs that daily-unit-csv.ts wrote and e-mail them.

    python3 scripts/send-unit-backup.py <out dir>

SMTP settings come from the environment (GitHub secrets in .github/workflows/daily-unit-backup.yml):
    MAIL_SERVER    e.g. smtp.gmail.com
    MAIL_PORT      465 (SSL, the default) or 587 (STARTTLS)
    MAIL_USERNAME  the sending account
    MAIL_PASSWORD  its password (for Gmail, an App Password)
    MAIL_TO        recipients, separated by commas
    MAIL_FROM      optional, defaults to MAIL_USERNAME
Python standard library only. Prints no recipient, no password and nothing about a car.
"""
import html
import io
import json
import os
import smtplib
import ssl
import sys
import zipfile
from email.message import EmailMessage
from email.utils import formataddr

out_dir = sys.argv[1] if len(sys.argv) > 1 else "unit-backup"
env = {k: os.environ.get(k, "").strip() for k in ("MAIL_SERVER", "MAIL_PORT", "MAIL_USERNAME", "MAIL_PASSWORD", "MAIL_TO", "MAIL_FROM")}
missing = [k for k in ("MAIL_SERVER", "MAIL_USERNAME", "MAIL_PASSWORD", "MAIL_TO") if not env[k]]
if missing:
    print("ยังไม่ได้ตั้งค่า GitHub secrets สำหรับส่งอีเมล: " + ", ".join(missing))
    print("ตั้งที่ GitHub → Settings → Secrets and variables → Actions → New repository secret")
    sys.exit(2)

with open(os.path.join(out_dir, "summary.json"), encoding="utf-8") as f:
    summary = json.load(f)
yards = summary["yards"]
files = [y["file"] for y in yards if y["file"]]
if not files:
    print("ไม่มีไฟล์ของยาร์ดไหนเลย ไม่ส่งอีเมล")
    sys.exit(1)

zip_name = f"SJWD_Unit_Backup_{summary['day']}.zip"
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name in files:
        z.write(os.path.join(out_dir, name), name)
data = buf.getvalue()
size_mb = len(data) / 1024 / 1024


def n(v):
    return f"{v:,}"


short = summary.get("short") or []
subject = f"สำรองข้อมูล Unit ทุกยาร์ด {summary['stamp']} · {n(summary['total'])} คัน"
if short:
    subject = "⚠ " + subject

lines = [
    f"ไฟล์ CSV หน้า Unit ของทุกยาร์ด ณ {summary['stamp']} (เวลาไทย)",
    f"แนบ {zip_name} ({size_mb:.1f} MB) มี {len(files)} ไฟล์ ยาร์ดละไฟล์ · {summary['columns']} คอลัมน์ตามมุมมองหน้า Unit",
    "",
]
for y in yards:
    lines.append(f"{y['name']}: {n(y['total'])} คัน · ในลาน {n(y['inYard'])} · Pre Gate-in {n(y['preGateIn'])} · อื่น ๆ {n(y['other'])}")
lines.append(f"รวม {n(summary['total'])} คัน")
if short:
    lines += ["", "⚠ ยาร์ดที่อ่านได้ไม่ครบตามที่ฐานข้อมูลนับ (ไฟล์อาจขาดบางคัน): " + ", ".join(short)]
text = "\n".join(lines)

cell = 'style="padding:6px 10px;border-bottom:1px solid #e3e6ea;text-align:right;font-variant-numeric:tabular-nums"'
head = 'style="padding:6px 10px;border-bottom:2px solid #c9ced6;text-align:right;font-weight:600"'
rows_html = "".join(
    f'<tr><td style="padding:6px 10px;border-bottom:1px solid #e3e6ea">{html.escape(y["name"])}</td>'
    f'<td {cell}><b>{n(y["total"])}</b></td><td {cell}>{n(y["inYard"])}</td><td {cell}>{n(y["preGateIn"])}</td><td {cell}>{n(y["other"])}</td></tr>'
    for y in yards
)
warn_html = (
    f'<p style="color:#b42318;margin:12px 0 0">⚠ ยาร์ดที่อ่านได้ไม่ครบตามที่ฐานข้อมูลนับ (ไฟล์อาจขาดบางคัน): {html.escape(", ".join(short))}</p>'
    if short else ""
)
body_html = f"""<div style="font-family:Segoe UI,Tahoma,sans-serif;font-size:14px;color:#1d2433">
<p style="margin:0 0 4px">ไฟล์ CSV หน้า Unit ของทุกยาร์ด ณ <b>{html.escape(summary['stamp'])}</b> (เวลาไทย)</p>
<p style="margin:0 0 14px;color:#5b6475">แนบ {html.escape(zip_name)} ({size_mb:.1f} MB) · {len(files)} ไฟล์ ยาร์ดละไฟล์ · {summary['columns']} คอลัมน์ตามมุมมองหน้า Unit</p>
<table style="border-collapse:collapse">
<tr><th style="padding:6px 10px;border-bottom:2px solid #c9ced6;text-align:left">ยาร์ด</th><th {head}>ทั้งหมด</th><th {head}>ในลาน</th><th {head}>Pre Gate-in</th><th {head}>อื่น ๆ</th></tr>
{rows_html}
<tr><td style="padding:6px 10px;font-weight:600">รวม</td><td {cell}><b>{n(summary['total'])}</b></td><td colspan="3"></td></tr>
</table>{warn_html}
<p style="margin:16px 0 0;color:#8a92a3;font-size:12px">ส่งอัตโนมัติทุกเที่ยงคืนโดย SJWD Yard Control</p>
</div>"""

msg = EmailMessage()
msg["Subject"] = subject
msg["From"] = formataddr(("SJWD Yard Control", env["MAIL_FROM"] or env["MAIL_USERNAME"]))
msg["To"] = ", ".join(a.strip() for a in env["MAIL_TO"].split(",") if a.strip())
msg.set_content(text)
msg.add_alternative(body_html, subtype="html")
msg.add_attachment(data, maintype="application", subtype="zip", filename=zip_name)

port = int(env["MAIL_PORT"] or 465)
ctx = ssl.create_default_context()
if port == 465:
    server = smtplib.SMTP_SSL(env["MAIL_SERVER"], port, context=ctx, timeout=60)
else:
    server = smtplib.SMTP(env["MAIL_SERVER"], port, timeout=60)
    server.starttls(context=ctx)
with server:
    server.login(env["MAIL_USERNAME"], env["MAIL_PASSWORD"])
    server.send_message(msg)
print(f"ส่งอีเมลแล้ว · {len(files)} ไฟล์ · {size_mb:.1f} MB")
