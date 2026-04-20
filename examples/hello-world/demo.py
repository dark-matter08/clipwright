"""Hello-world Playwright script. Clipwright calls `run(page, mark)`.

Call `await mark("action", **data)` to record timestamped moments. These drive
dead-time trimming and camera keyframes downstream.
"""


async def run(page, mark):
    await page.wait_for_load_state("networkidle")
    await page.wait_for_timeout(500)

    await page.evaluate(
        "document.body.style.fontFamily='Menlo, ui-monospace, monospace';"
        "document.body.style.background='#0a0f1d';"
        "document.body.style.color='#e6f0fa';"
    )
    await mark("settle")
    await page.wait_for_timeout(800)

    await page.get_by_role("link", name="More information").click()
    await mark("click", selector='role=link[name="More information"]')
    await page.wait_for_load_state("networkidle")
    await page.wait_for_timeout(1000)
    await mark("settle")
