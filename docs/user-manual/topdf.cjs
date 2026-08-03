const { chromium } = require('/opt/node22/lib/node_modules/playwright')

const FOOT = `
<div style="width:100%;font-size:8pt;color:#6E7C93;font-family:Loma,sans-serif;padding:0 16mm;
            display:flex;justify-content:space-between;align-items:center;
            border-top:.5pt solid #D8DFE9;padding-top:2mm">
  <span>คู่มือการใช้งานระบบ SJWD Yard Control &nbsp;·&nbsp; 2PS-SJWD-UM-001 &nbsp;·&nbsp; ฉบับที่ 1.0</span>
  <span>หน้า <span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>`

;(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
  const page = await browser.newPage()
  await page.goto('file://' + process.cwd() + '/manual.html', { waitUntil: 'load' })
  await page.emulateMedia({ media: 'print' })

  // A sub-section is kept whole (.sec = page-break-inside: avoid), but a section
  // taller than this can never fit a page — leaving it "unbreakable" only pushes
  // it wholesale and blanks out the page before it. Release those.
  const released = await page.evaluate((maxPx) => {
    let n = 0
    for (const el of document.querySelectorAll('.sec')) {
      // .keep blocks (long reference tables) hold together up to a full page
      const limit = el.classList.contains('keep') ? 940 : maxPx
      if (el.getBoundingClientRect().height > limit) { el.classList.remove('sec'); n++ }
    }
    return n
  }, 520)
  console.log(`sections released: ${released}`)
  await page.pdf({
    path: 'SJWD-Yard-Control-User-Manual.pdf',
    format: 'A4',
    printBackground: true,
    margin: { top: '16mm', bottom: '18mm', left: '16mm', right: '16mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: FOOT,
  })
  await browser.close()
})()
