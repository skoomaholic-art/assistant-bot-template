"""Read-only browser smoke test for Cover Studio compact UI (no Telegram auth)."""
import contextlib
import http.server
import socketserver
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):
        pass


def main():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", 0), Quiet) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_address[1]}/cover-studio/"
        with sync_playwright() as p:
            browser = p.chromium.launch()
            try:
                page = browser.new_page(viewport={"width": 1280, "height": 850})
                page.goto(base, wait_until="domcontentloaded")
                page.wait_for_function("Boolean(window.SkoomaCompactUI && window.__skooma && window.SkoomaPages)")
                assert page.locator("details.cs-fold").count() == 11
                assert page.locator("nav.cs-quickbar button").count() == 7

                controls = ["title", "subtitle", "preset", "format", "logoUpload",
                            "slides", "pipeApprove", "imgQ", "aiPreset", "buildCarousel",
                            "exportPngSecondary"]
                for field in controls:
                    assert page.locator(f"#{field}").count() == 1, field
                    assert page.locator(f"#{field}").evaluate("el=>!!el.closest('details.cs-fold')"), field

                order = page.locator("aside.right .controls > .control-group").evaluate_all(
                    "els=>els.map(e=>e.dataset.section)"
                )
                assert order == ["slides", "images", "publish", "ai", "carousel", "export", "help"], order

                assert page.locator('details[data-section="slides"]').evaluate("e=>e.open")
                assert page.locator('details[data-section="text"]').evaluate("e=>e.open")
                assert not page.locator('details[data-section="background"]').evaluate("e=>e.open")

                page.get_by_role("button", name="🎬 Кадры").click()
                assert page.locator('details[data-section="images"]').evaluate("e=>e.open")
                page.locator('details[data-section="images"] > summary').click()
                assert not page.locator('details[data-section="images"]').evaluate("e=>e.open")
                page.locator('details[data-section="images"] > summary').focus()
                page.keyboard.press("Enter")
                assert page.locator('details[data-section="images"]').evaluate("e=>e.open")

                # Check the original editor's input handlers and rendering.
                before = page.locator("#art").evaluate("el=>el.toDataURL('image/png')")
                page.locator("#title").fill("ВИЗУАЛЬНЫЙ ТЕСТ")
                page.wait_for_timeout(300)
                after = page.locator("#art").evaluate("el=>el.toDataURL('image/png')")
                assert before != after, "rendering did not update after title edit"

                mobile = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True)
                mobile.goto(base, wait_until="domcontentloaded")
                mobile.wait_for_selector("nav.cs-quickbar button")
                # телефон: одна колонка в порядке работы, отправка в нижней панели
                assert mobile.locator("aside.left .controls > .control-group").evaluate_all("els=>els.map(e=>e.dataset.section)")[:4] == ["slides", "text", "background", "images"]
                assert mobile.locator(".cs-actionbar .cs-ab-primary").is_visible()
                mobile.get_by_role("button", name="📤 Отправка").click()
                assert mobile.locator('details[data-section="publish"]').evaluate("e=>e.open")
                assert mobile.locator("#pipeApprove").count() == 1
                assert mobile.locator("nav.cs-quickbar").evaluate("e=>getComputedStyle(e).overflowX") == "auto"

                render = browser.new_page()
                render.goto(base + "?render=1", wait_until="domcontentloaded")
                render.wait_for_function("Boolean(window.__skooma && window.SkoomaPages)")
                assert render.locator("nav.cs-quickbar").count() == 0
                assert render.locator(".cs-compact-ui").count() == 0
                assert render.locator("#art").count() == 1
                print("PASS: 11 folders, navigation, keyboard, original controls, canvas, mobile, render mode")
            finally:
                browser.close()


if __name__ == "__main__":
    main()
