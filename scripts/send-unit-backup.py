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
import re
import smtplib
import ssl
import sys
import time
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

try:
    port = int(env["MAIL_PORT"] or 465)
except ValueError:
    print("MAIL_PORT ต้องเป็นตัวเลข: 465 (Gmail) หรือ 587")
    sys.exit(2)

# Google shows an App Password as four groups of four ("abcd efgh ijkl mnop"); the spaces are only
# display, and a password pasted with them is refused, so they are taken out
password = env["MAIL_PASSWORD"]
squeezed = re.sub(r"\s+", "", password)
if re.fullmatch(r"[A-Za-z]{16}", squeezed):
    password = squeezed


def shape() -> list[str]:
    """What the settings look like, with nothing secret in it (this repository's Actions log is public)."""
    u = env["MAIL_USERNAME"]
    server_kind = "เป็นของ Gmail" if env["MAIL_SERVER"].lower() == "smtp.gmail.com" else "ไม่ใช่ smtp.gmail.com"
    user_kind = "เป็นรูปแบบอีเมล" if re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", u) else "ไม่ใช่รูปแบบอีเมล"
    if u.lower().endswith(("@gmail.com", "@googlemail.com")):
        user_kind += " (บัญชี Gmail)"
    pass_kind = "เป็นรูปแบบ App Password 16 ตัว" if re.fullmatch(r"[a-z]{16}", password.lower()) else "ไม่ใช่รูปแบบ App Password 16 ตัว"
    return [
        f"  · MAIL_SERVER {server_kind} · พอร์ต {port}",
        f"  · MAIL_USERNAME {user_kind}",
        f"  · MAIL_PASSWORD ยาว {len(password)} ตัว · {pass_kind}",
    ]


HINTS = [
    "ตรวจ 3 อย่าง:",
    "  1. MAIL_PASSWORD ต้องเป็น App Password 16 ตัวจาก myaccount.google.com/apppasswords ไม่ใช่รหัสผ่าน Gmail ปกติ",
    "  2. MAIL_USERNAME ต้องเป็นอีเมลบัญชีเดียวกับที่สร้าง App Password นั้น",
    "  3. บัญชีนั้นเปิดการยืนยันแบบ 2 ขั้นตอนอยู่",
]


def send(p: int, mech: str) -> None:
    ctx = ssl.create_default_context()
    if p == 465:
        server = smtplib.SMTP_SSL(env["MAIL_SERVER"], p, context=ctx, timeout=60)
    else:
        server = smtplib.SMTP(env["MAIL_SERVER"], p, timeout=60)
        server.ehlo()
        server.starttls(context=ctx)
    with server:
        server.ehlo()
        if mech == "LOGIN":
            server.user, server.password = env["MAIL_USERNAME"], password
            server.auth("LOGIN", server.auth_login, initial_response_ok=False)
        else:
            server.login(env["MAIL_USERNAME"], password)
        server.send_message(msg)


# Gmail can drop a login without a word. Try the other ways it accepts before giving up, and say how
# each one ended, so one run shows whether the account or the way of connecting is the problem.
# Ports are named by kind: the port's own number is a secret value, and the log would mask it.
ways = [(port, "PLAIN")]
if env["MAIL_SERVER"].lower() == "smtp.gmail.com":
    ways += [(587 if port == 465 else 465, "PLAIN"), (port, "LOGIN")]
kind = lambda p: "SSL" if p == 465 else "STARTTLS"
outcomes: list[str] = []
for i, (p, mech) in enumerate(ways):
    try:
        send(p, mech)
        if i:
            print(f"ส่งได้ทาง {kind(p)} · AUTH {mech} (ทางแรกไม่ผ่าน: {outcomes[0]})")
        break
    except smtplib.SMTPAuthenticationError as e:
        reply = e.smtp_error.decode(errors="replace") if isinstance(e.smtp_error, bytes) else str(e.smtp_error)
        outcomes.append(f"ล็อกอินไม่ผ่าน · ตอบ {e.smtp_code}: {' '.join(reply.split())[:200]}")
    except (smtplib.SMTPException, OSError) as e:
        outcomes.append(f"การเชื่อมต่อถูกตัด ({type(e).__name__}: {e})")
    if i < len(ways) - 1:
        time.sleep(5)
else:
    print("ส่งอีเมลไม่สำเร็จ ลองครบทุกทางแล้ว:")
    for (p, mech), o in zip(ways, outcomes):
        print(f"  · {kind(p)} · AUTH {mech}: {o}")
    print("ค่าที่ตั้งไว้:")
    print("\n".join(shape() + HINTS))
    print("  4. ดูกล่องจดหมายของบัญชีที่ใช้ส่ง ถ้ามีเมลจาก Google เรื่องการลงชื่อเข้าใช้ที่ถูกบล็อก ให้กดยืนยันว่าเป็นคุณ")
    sys.exit(1)
print(f"ส่งอีเมลแล้ว · {len(files)} ไฟล์ · {size_mb:.1f} MB")
