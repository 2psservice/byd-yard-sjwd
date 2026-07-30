#!/usr/bin/env python3
"""Assemble the SJWD Yard Control user manual and render it to PDF.

Two passes: the first render tells us which page each numbered heading landed
on, the second bakes those numbers into the table of contents.
"""
import os, re, subprocess, sys, types

# the container's `cryptography` wheel panics on import; pypdf only wants it for
# encrypted PDFs, and a blank stub makes it fall back cleanly
sys.modules.setdefault('cryptography', types.ModuleType('cryptography'))

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

DOC_NO   = '2PS-SJWD-UM-001'
VERSION  = '1.0'
DATE_TH  = '30 กรกฎาคม 2569'
TITLE    = 'คู่มือการใช้งานระบบ SJWD Yard Control'

logo = open('logo.b64').read().strip()
css  = open('style.css').read()
body = '\n'.join(open(f'body{i}.html').read() for i in (1, 2, 3, 4))

# ── table of contents, built from the h2/h3 in the body ──────────────────────
entries = []  # (level, number, title, anchor)
for m in re.finditer(r'<h([23]) id="([^"]+)"><span class="num">([^<]*)</span>([^<]*)</h\1>', body):
    entries.append((int(m.group(1)), m.group(3).strip(), m.group(4).strip(), m.group(2)))

def toc_html(pages=None):
    out = []
    for lvl, num, title, anchor in entries:
        pg = pages.get(anchor, '') if pages else ''
        out.append(
            f'<div class="l{lvl - 1}"><span class="n">{num}</span>'
            f'<span>{title}</span><span class="dots"></span>'
            f'<span class="pg">{pg}</span></div>'
        )
    return '\n'.join(out)

COVER = f'''
<div class="cover">
  <img class="logo" src="data:image/png;base64,{logo}" alt="2PS Services">
  <div class="org">บริษัท 2PS Services จำกัด</div>
  <div class="rule"></div>
  <div class="kicker">User Manual</div>
  <h1>{TITLE}</h1>
  <div class="sub">ระบบบริหารจัดการลานจอดรถยนต์</div>
  <div class="sub-en">Vehicle Yard Management System — User Manual</div>
  <div class="classif">เอกสารใช้ภายในองค์กร</div>
  <div class="spacer"></div>
  <div class="meta">
    <table>
      <tr><td>เลขที่เอกสาร</td><td>{DOC_NO}</td></tr>
      <tr><td>ฉบับแก้ไขครั้งที่</td><td>{VERSION}</td></tr>
      <tr><td>วันที่มีผลบังคับใช้</td><td>{DATE_TH}</td></tr>
      <tr><td>ระบบที่เกี่ยวข้อง</td><td>SJWD Yard Control (byd-yard-sjwd.pages.dev)</td></tr>
      <tr><td>จัดทำโดย</td><td>ฝ่ายเทคโนโลยีสารสนเทศ</td></tr>
    </table>
  </div>
</div>
'''

CONTROL = '''
<h2 class="no-break" style="page-break-before:auto">การควบคุมเอกสาร</h2>

<h4>ประวัติการแก้ไขเอกสาร</h4>
<table class="t dc">
  <tr><th style="width:20mm" class="c">ครั้งที่</th><th style="width:30mm">วันที่</th><th>รายละเอียดการแก้ไข</th><th style="width:34mm">ผู้จัดทำ</th></tr>
  <tr><td class="c">1.0</td><td>''' + DATE_TH + '''</td><td>จัดทำเอกสารฉบับแรก ครอบคลุมการใช้งานภาคสนาม 10 สถานี และหน้าจอผู้ดูแลระบบ 15 หน้าจอ</td><td>ฝ่ายเทคโนโลยีสารสนเทศ</td></tr>
  <tr><td class="c">&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
  <tr><td class="c">&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
</table>

<h4>การอนุมัติเอกสาร</h4>
<table class="sig">
  <tr>
    <td style="width:33.4%"><div class="role">จัดทำโดย</div><div class="space"></div><div>ลงชื่อ ......................................</div><div class="role" style="margin-top:1mm">วันที่ ................................</div></td>
    <td style="width:33.3%"><div class="role">ตรวจสอบโดย</div><div class="space"></div><div>ลงชื่อ ......................................</div><div class="role" style="margin-top:1mm">วันที่ ................................</div></td>
    <td style="width:33.3%"><div class="role">อนุมัติโดย</div><div class="space"></div><div>ลงชื่อ ......................................</div><div class="role" style="margin-top:1mm">วันที่ ................................</div></td>
  </tr>
</table>

<h4>การแจกจ่ายเอกสาร</h4>
<table class="t dc">
  <tr><th style="width:52mm">หน่วยงาน / ตำแหน่ง</th><th>วัตถุประสงค์การใช้งาน</th></tr>
  <tr><td>ผู้จัดการลาน</td><td>กำกับดูแลการปฏิบัติงานให้เป็นไปตามขั้นตอน</td></tr>
  <tr><td>หัวหน้างานภาคสนาม</td><td>ฝึกอบรมและควบคุมการปฏิบัติงานประจำวัน</td></tr>
  <tr><td>พนักงานปฏิบัติงานภาคสนาม</td><td>อ้างอิงขั้นตอนการใช้งานระบบ</td></tr>
  <tr><td>ผู้ดูแลระบบ</td><td>บริหารจัดการข้อมูลและบัญชีผู้ใช้งาน</td></tr>
</table>

<div class="box"><span class="lbl">การควบคุมสำเนา</span>เอกสารฉบับนี้เป็นทรัพย์สินของบริษัท 2PS Services จำกัด ห้ามทำสำเนาหรือเผยแพร่ต่อบุคคลภายนอกโดยไม่ได้รับอนุญาต ผู้ใช้งานต้องตรวจสอบว่าใช้เอกสารฉบับแก้ไขล่าสุดเสมอ</div>
'''


MARK = '<span style="font-size:1px;color:#ffffff">[[{}]]</span>'

def marked(html_body):
    """Tag every heading with an invisible ASCII marker — Thai text extracts
    unreliably from the PDF, a plain ASCII token does not."""
    return re.sub(
        r'(<h([23]) id="([^"]+)">)',
        lambda m: m.group(1) + MARK.format(m.group(3)),
        html_body,
    )


def render(toc, mark=True):
    html = f'''<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<title>{TITLE}</title>
<style>{css}</style>
</head><body>
{COVER}
{CONTROL}
<h2 class="no-break">สารบัญ</h2>
<div class="toc">
{toc}
</div>
{marked(body) if mark else body}
</body></html>'''
    open('manual.html', 'w').write(html)
    subprocess.run(['node', 'topdf.cjs'], check=True)


# ── pass 1: render, then read back where each heading landed ────────────────
render(toc_html())

from pypdf import PdfReader
reader = PdfReader('SJWD-Yard-Control-User-Manual.pdf')
page_text = [(p.extract_text() or '').replace('​', '') for p in reader.pages]

def find_page(anchor):
    """Page carrying this heading's invisible marker."""
    key = f'[[{anchor}]]'
    for i, txt in enumerate(page_text):
        if key in txt.replace(' ', '').replace('\n', ''):
            return i + 1
    return ''

pages = {anchor: find_page(anchor) for _lvl, _num, _title, anchor in entries}
missing = [a for a, p in pages.items() if not p]
if missing:
    print('WARN: no page found for', missing, file=sys.stderr)

# ── pass 2: TOC now carries real page numbers, markers dropped so the PDF's
#    text layer is clean. The markers are 1px glyphs inside existing headings,
#    so removing them cannot reflow the document — asserted below.
n1 = len(reader.pages)
render(toc_html(pages), mark=False)
n2 = len(PdfReader('SJWD-Yard-Control-User-Manual.pdf').pages)
assert n1 == n2, f'pagination shifted between passes: {n1} → {n2}'
print('pages:', n2)
