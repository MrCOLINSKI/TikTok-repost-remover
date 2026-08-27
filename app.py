"""
TikTok Repost Remover — local-only desktop app.

Single entry point:  python app.py

Starts a FastAPI server bound strictly to 127.0.0.1:8731, opens the UI in your
default browser, and drives a HEADED Chromium window via Playwright.

Design constraints (do not change):
  * 127.0.0.1 only. Never 0.0.0.0, never deployed.
  * No auth, no accounts, no multi-user. One person, one machine.
  * No credentials anywhere. You log in by hand in the real browser window.
  * Never headless.
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import sys
import threading
import time
import webbrowser
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# SELECTORS
#
# !!! TikTok's DOM changes often — frequently with no warning and no version.
# !!! When the app suddenly "finds 0 reposts" or "can't find the repost button",
# !!! this dict is the ONLY place you should need to edit.
#
# Every entry is an ORDERED LIST of candidate selectors. The app tries each in
# turn and uses the first one that matches, so it is safe to leave old
# selectors in the list as fallbacks and add the new one at the top.
#
# To find a new selector: open the headed window this app controls, right-click
# the element -> Inspect, and prefer a stable `data-e2e="..."` attribute over
# a hashed CSS class (TikTok's class names are generated and rotate).
# ---------------------------------------------------------------------------
SELECTORS: Dict[str, List[str]] = {
    # Anything that only renders for a logged-in session.
    "logged_in_marker": [
        '[data-e2e="nav-profile"]',
        '[data-e2e="profile-icon"]',
        'a[data-e2e="nav-profile"]',
    ],
    # Link to your own profile, used to discover your @username.
    "profile_link": [
        'a[data-e2e="nav-profile"]',
        '[data-e2e="nav-profile"] a',
        'a[href^="/@"][data-e2e]',
    ],
    # The "Reposts" tab on your own profile page.
    "repost_tab": [
        '[data-e2e="repost-tab"]',
        'p[data-e2e="repost-tab"]',
        'span[data-e2e="repost-tab"]',
        'div[role="tablist"] >> text=Reposts',
        'text=Reposts',
    ],
    # Video tiles inside the currently selected profile tab.
    "video_grid_link": [
        '[data-e2e="user-post-item"] a[href*="/video/"]',
        '[data-e2e="user-post-item-list"] a[href*="/video/"]',
        'div[data-e2e="user-post-item-list"] a[href*="/video/"]',
        'a[href*="/video/"]',
    ],
    # The repost button on a video detail page.
    "repost_button": [
        '[data-e2e="repost-icon"]',
        'button[data-e2e="repost-icon"]',
        'div[data-e2e="repost-icon"]',
        'button[aria-label*="epost"]',
        'div[aria-label*="epost"]',
        'span[data-e2e="undefined-repost"]',
    ],
    # Confirmation control some UI variants show after clicking repost/undo.
    "repost_confirm": [
        'button:has-text("Remove repost")',
        'button:has-text("Undo repost")',
        'div[role="dialog"] button:has-text("Remove")',
        'div[role="button"]:has-text("Remove repost")',
    ],
    # Presence of these means TikTok wants a human (captcha / rate limit wall).
    "captcha": [
        "#captcha-verify-container",
        ".captcha_verify_container",
        'div[id^="captcha"]',
    ],
    # Video page is a 404 / removed video.
    "video_unavailable": [
        'text=Video currently unavailable',
        'text=This video is unavailable',
        '[data-e2e="video-unavailable"]',
    ],
}

# Words that mean "this is currently reposted, clicking will undo it".
REPOST_ACTIVE_HINTS = ("undo", "remove", "reposted", "cancel")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
HOST = "127.0.0.1"  # never anything else
PORT = 8731
BASE_DIR = Path(__file__).resolve().parent
PROFILE_DIR = BASE_DIR / "tiktok-profile"
LEDGER_PATH = BASE_DIR / "removed.jsonl"
STATIC_DIR = BASE_DIR / "static"

DEFAULT_CAP = 200
MIN_DELAY_S = 3.0
MAX_DELAY_S = 8.0
REMOVAL_ATTEMPTS = 3
NAV_TIMEOUT_MS = 45_000
SELECTOR_TIMEOUT_MS = 8_000


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Event bus (Server-Sent Events)
# ---------------------------------------------------------------------------
class EventBus:
    """Fan-out of backend log/progress events to any connected SSE clients."""

    def __init__(self, history: int = 500) -> None:
        self._subscribers: Set[asyncio.Queue] = set()
        self._history: List[dict] = []
        self._history_max = history

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subscribers.add(q)
        for item in self._history[-100:]:
            q.put_nowait(item)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def emit(self, kind: str, message: str = "", **data: Any) -> None:
        evt = {"kind": kind, "message": message, "ts": now_iso(), **data}
        if kind == "log":
            self._history.append(evt)
            del self._history[: max(0, len(self._history) - self._history_max)]
        for q in list(self._subscribers):
            try:
                q.put_nowait(evt)
            except asyncio.QueueFull:
                pass

    def log(self, message: str, level: str = "info") -> None:
        print(f"[{level}] {message}", flush=True)
        self.emit("log", message, level=level)


BUS = EventBus()


# ---------------------------------------------------------------------------
# Ledger: removed.jsonl
# ---------------------------------------------------------------------------
class Ledger:
    """Append-only record of every removal attempt.

    A URL logged as `success` (or `already_removed`) is skipped on later runs.
    URLs logged as `failed` are retried, which is the whole point of keeping
    the failures in the file.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    def done_urls(self) -> Set[str]:
        done: Set[str] = set()
        if not self.path.exists():
            return done
        with self.path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("status") in ("success", "already_removed"):
                    url = rec.get("url")
                    if url:
                        done.add(url)
        return done

    def append(self, url: str, status: str, detail: str = "") -> None:
        rec = {"url": url, "timestamp": now_iso(), "status": status}
        if detail:
            rec["detail"] = detail
        with self._lock:
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec) + "\n")


LEDGER = Ledger(LEDGER_PATH)


# ---------------------------------------------------------------------------
# Run state
# ---------------------------------------------------------------------------
@dataclass
class RunState:
    phase: str = "idle"  # idle | logging_in | scanning | removing | stopping
    total: int = 0
    processed: int = 0
    success: int = 0
    failed: int = 0
    skipped: int = 0
    current_url: str = ""
    cap: int = DEFAULT_CAP
    scanned: List[str] = field(default_factory=list)
    scan_complete: bool = False
    last_error: str = ""

    def snapshot(self, logged_in: bool, browser_open: bool) -> dict:
        return {
            "phase": self.phase,
            "busy": self.phase not in ("idle",),
            "logged_in": logged_in,
            "browser_open": browser_open,
            "total": self.total,
            "processed": self.processed,
            "success": self.success,
            "failed": self.failed,
            "skipped": self.skipped,
            "current_url": self.current_url,
            "cap": self.cap,
            "scan_complete": self.scan_complete,
            "scanned_count": len(self.scanned),
            "last_error": self.last_error,
        }


STATE = RunState()
STOP = asyncio.Event()
JOB_LOCK = asyncio.Lock()
CURRENT_TASK: Optional[asyncio.Task] = None


def push_progress() -> None:
    BUS.emit("progress", **STATE.snapshot(TT.logged_in, TT.is_open))


# ---------------------------------------------------------------------------
# Playwright automation
# ---------------------------------------------------------------------------
class TikTok:
    """Owns the single persistent, HEADED browser context."""

    def __init__(self) -> None:
        self._pw = None
        self._ctx = None
        self._page = None
        self.logged_in = False
        self.username: Optional[str] = None

    @property
    def is_open(self) -> bool:
        return self._ctx is not None

    async def launch(self):
        if self._ctx is not None:
            return self._ctx
        from playwright.async_api import async_playwright

        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        BUS.log(f"Launching headed Chromium with profile {PROFILE_DIR}")
        self._pw = await async_playwright().start()
        self._ctx = await self._pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,  # never headless — you need to see and drive it
            viewport={"width": 1280, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        self._ctx.set_default_timeout(SELECTOR_TIMEOUT_MS)
        self._ctx.set_default_navigation_timeout(NAV_TIMEOUT_MS)
        pages = self._ctx.pages
        self._page = pages[0] if pages else await self._ctx.new_page()
        return self._ctx

    async def close(self) -> None:
        try:
            if self._ctx is not None:
                await self._ctx.close()
        except Exception:
            pass
        try:
            if self._pw is not None:
                await self._pw.stop()
        except Exception:
            pass
        self._ctx = None
        self._pw = None
        self._page = None

    async def page(self):
        await self.launch()
        if self._page is None or self._page.is_closed():
            self._page = await self._ctx.new_page()
        return self._page

    # -- selector helpers ---------------------------------------------------
    async def _first(self, page, key: str, timeout: int = SELECTOR_TIMEOUT_MS):
        """Return the first visible locator matching any candidate for `key`."""
        deadline = time.monotonic() + timeout / 1000
        while True:
            for sel in SELECTORS[key]:
                try:
                    loc = page.locator(sel).first
                    if await loc.count() and await loc.is_visible():
                        return loc
                except Exception:
                    continue
            if time.monotonic() >= deadline:
                return None
            await asyncio.sleep(0.25)

    async def _present(self, page, key: str) -> bool:
        for sel in SELECTORS[key]:
            try:
                if await page.locator(sel).first.count():
                    return True
            except Exception:
                continue
        return False

    async def _guard_captcha(self, page) -> None:
        if await self._present(page, "captcha"):
            raise RuntimeError(
                "TikTok is showing a captcha / verification wall. "
                "Solve it in the browser window, then continue."
            )

    # -- session ------------------------------------------------------------
    async def check_login(self) -> bool:
        """True if the persistent profile currently holds a live session."""
        try:
            page = await self.page()
            if "tiktok.com" not in (page.url or ""):
                await page.goto("https://www.tiktok.com/", wait_until="domcontentloaded")
            cookies = await self._ctx.cookies("https://www.tiktok.com")
            has_sid = any(
                c.get("name") in ("sessionid", "sessionid_ss") and c.get("value")
                for c in cookies
            )
            marker = await self._first(page, "logged_in_marker", timeout=4000)
            self.logged_in = bool(has_sid or marker)
            if self.logged_in and not self.username:
                await self._discover_username(page)
            return self.logged_in
        except Exception as exc:
            BUS.log(f"Login check failed: {exc}", "warn")
            self.logged_in = False
            return False

    async def _discover_username(self, page) -> Optional[str]:
        try:
            loc = await self._first(page, "profile_link", timeout=5000)
            if loc is not None:
                href = await loc.get_attribute("href")
                if href and "/@" in href:
                    self.username = "@" + href.split("/@", 1)[1].split("?")[0].strip("/")
                    BUS.log(f"Detected account {self.username}")
                    return self.username
        except Exception:
            pass
        return None

    async def open_login(self) -> None:
        page = await self.page()
        BUS.log("Opening tiktok.com/login — log in by hand in that window.")
        await page.goto("https://www.tiktok.com/login", wait_until="domcontentloaded")
        try:
            await page.bring_to_front()
        except Exception:
            pass

    async def wait_for_login(self, timeout_s: int = 600) -> bool:
        """Poll until a session cookie appears. No credentials, ever."""
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if STOP.is_set():
                BUS.log("Login wait cancelled.", "warn")
                return False
            try:
                cookies = await self._ctx.cookies("https://www.tiktok.com")
                if any(
                    c.get("name") in ("sessionid", "sessionid_ss") and c.get("value")
                    for c in cookies
                ):
                    self.logged_in = True
                    page = await self.page()
                    await self._discover_username(page)
                    BUS.log("Login detected.", "success")
                    return True
            except Exception as exc:
                BUS.log(f"Waiting for login: {exc}", "warn")
            await asyncio.sleep(2)
        BUS.log("Timed out waiting for login.", "error")
        return False

    # -- scanning -----------------------------------------------------------
    async def scan_reposts(self) -> List[str]:
        """Collect the FULL list of repost URLs before anything is removed."""
        page = await self.page()
        if not self.username:
            await page.goto("https://www.tiktok.com/foryou", wait_until="domcontentloaded")
            await self._discover_username(page)
        if not self.username:
            raise RuntimeError(
                "Could not determine your @username. Open your profile in the "
                "browser window once, then scan again."
            )

        url = f"https://www.tiktok.com/{self.username}"
        BUS.log(f"Opening profile {url}")
        await page.goto(url, wait_until="domcontentloaded")
        await self._guard_captcha(page)

        tab = await self._first(page, "repost_tab", timeout=15_000)
        if tab is None:
            raise RuntimeError(
                "Could not find the Reposts tab. TikTok's DOM may have changed — "
                "update SELECTORS['repost_tab'] in app.py."
            )
        await tab.click()
        BUS.log("Reposts tab selected. Scrolling to load everything…")
        await asyncio.sleep(2.5)

        seen: List[str] = []
        seen_set: Set[str] = set()
        stagnant = 0
        while stagnant < 4:
            if STOP.is_set():
                BUS.log("Scan stopped by user.", "warn")
                break
            found = await self._collect_grid_links(page)
            new = [u for u in found if u not in seen_set]
            for u in new:
                seen_set.add(u)
                seen.append(u)
            if new:
                stagnant = 0
                BUS.log(f"Found {len(seen)} reposts so far…")
                STATE.scanned = list(seen)
                STATE.total = len(seen)
                push_progress()
            else:
                stagnant += 1
            await page.mouse.wheel(0, 4000)
            await asyncio.sleep(random.uniform(1.0, 1.8))
            await self._guard_captcha(page)

        BUS.log(f"Scan complete: {len(seen)} reposts.", "success")
        return seen

    async def _collect_grid_links(self, page) -> List[str]:
        urls: List[str] = []
        for sel in SELECTORS["video_grid_link"]:
            try:
                hrefs = await page.eval_on_selector_all(
                    sel, "els => els.map(e => e.href)"
                )
            except Exception:
                continue
            for h in hrefs or []:
                if h and "/video/" in h:
                    clean = h.split("?")[0]
                    if clean not in urls:
                        urls.append(clean)
            if urls:
                break
        return urls

    # -- removal ------------------------------------------------------------
    async def _repost_state(self, page) -> Optional[bool]:
        """True = currently reposted, False = not, None = undeterminable.

        Heuristics, in order of reliability. TikTok exposes no stable flag, so
        we read aria-pressed, then the accessible label, then class hints.
        """
        btn = await self._first(page, "repost_button", timeout=SELECTOR_TIMEOUT_MS)
        if btn is None:
            return None
        try:
            pressed = await btn.get_attribute("aria-pressed")
            if pressed in ("true", "false"):
                return pressed == "true"
        except Exception:
            pass
        for attr in ("aria-label", "title", "data-e2e"):
            try:
                val = (await btn.get_attribute(attr)) or ""
            except Exception:
                val = ""
            low = val.lower()
            if low:
                if any(h in low for h in REPOST_ACTIVE_HINTS):
                    return True
                if "repost" in low:
                    return False
        try:
            cls = ((await btn.get_attribute("class")) or "").lower()
            if any(h in cls for h in ("active", "reposted", "selected")):
                return True
        except Exception:
            pass
        try:
            txt = ((await btn.inner_text()) or "").strip().lower()
            if txt:
                if any(h in txt for h in REPOST_ACTIVE_HINTS):
                    return True
                if "repost" in txt:
                    return False
        except Exception:
            pass
        return None

    async def remove_repost(self, url: str) -> tuple[str, str]:
        """Remove one repost. Returns (status, detail).

        status: success | already_removed | failed
        """
        page = await self.page()
        await page.goto(url, wait_until="domcontentloaded")
        await self._guard_captcha(page)

        if await self._present(page, "video_unavailable"):
            return "already_removed", "video unavailable"

        before = await self._repost_state(page)
        if before is False:
            return "already_removed", "not reposted"

        btn = await self._first(page, "repost_button", timeout=12_000)
        if btn is None:
            raise RuntimeError(
                "repost button not found (update SELECTORS['repost_button'])"
            )
        await btn.scroll_into_view_if_needed()
        await btn.click()
        await asyncio.sleep(1.2)

        confirm = await self._first(page, "repost_confirm", timeout=2500)
        if confirm is not None:
            await confirm.click()
            await asyncio.sleep(1.2)

        # Verify the state actually flipped, in the live DOM and then after a
        # reload — a click that "worked" without flipping is a failure.
        after = await self._repost_state(page)
        if after is False:
            return "success", "state flipped"

        await page.reload(wait_until="domcontentloaded")
        await self._guard_captcha(page)
        after = await self._repost_state(page)
        if after is False:
            return "success", "verified after reload"
        if after is None:
            raise RuntimeError("could not verify repost state after click")
        raise RuntimeError("repost still active after click")


TT = TikTok()


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------
async def _interruptible_sleep(seconds: float) -> None:
    try:
        await asyncio.wait_for(STOP.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass


async def job_login() -> None:
    STATE.phase = "logging_in"
    STATE.last_error = ""
    push_progress()
    try:
        await TT.launch()
        await TT.open_login()
        await TT.wait_for_login()
    except Exception as exc:
        STATE.last_error = str(exc)
        BUS.log(f"Login failed: {exc}", "error")
    finally:
        STATE.phase = "idle"
        push_progress()


async def job_scan() -> None:
    STATE.phase = "scanning"
    STATE.last_error = ""
    STATE.scanned = []
    STATE.scan_complete = False
    STATE.total = STATE.processed = STATE.success = STATE.failed = STATE.skipped = 0
    STATE.current_url = ""
    push_progress()
    try:
        await TT.launch()
        if not await TT.check_login():
            raise RuntimeError("Not logged in. Click 'Log in to TikTok' first.")
        urls = await TT.scan_reposts()
        STATE.scanned = urls
        STATE.total = len(urls)
        STATE.scan_complete = not STOP.is_set()
        BUS.emit("scan_result", f"{len(urls)} reposts found", urls=urls)
    except Exception as exc:
        STATE.last_error = str(exc)
        BUS.log(f"Scan failed: {exc}", "error")
    finally:
        STATE.phase = "idle"
        push_progress()


async def job_remove(cap: int) -> None:
    STATE.phase = "removing"
    STATE.last_error = ""
    STATE.processed = STATE.success = STATE.failed = STATE.skipped = 0
    STATE.cap = cap
    push_progress()
    try:
        await TT.launch()
        if not await TT.check_login():
            raise RuntimeError("Not logged in.")

        done = LEDGER.done_urls()
        queue = [u for u in STATE.scanned if u not in done]
        skipped_upfront = len(STATE.scanned) - len(queue)
        if skipped_upfront:
            BUS.log(f"Skipping {skipped_upfront} URL(s) already logged as removed.")
            STATE.skipped = skipped_upfront
        if len(queue) > cap:
            BUS.log(f"Cap {cap} — {len(queue) - cap} URL(s) left for a later run.")
            queue = queue[:cap]

        STATE.total = len(queue)
        push_progress()
        BUS.log(f"Removing {len(queue)} repost(s), sequentially.", "success")

        for idx, url in enumerate(queue, start=1):
            if STOP.is_set():
                BUS.log("Stop requested — halting cleanly.", "warn")
                break
            STATE.current_url = url
            push_progress()
            BUS.log(f"[{idx}/{len(queue)}] {url}")

            status, detail, last_exc = "failed", "", ""
            for attempt in range(1, REMOVAL_ATTEMPTS + 1):
                if STOP.is_set():
                    break
                try:
                    status, detail = await TT.remove_repost(url)
                    break
                except Exception as exc:  # one failure never kills the run
                    last_exc = str(exc)
                    BUS.log(
                        f"  attempt {attempt}/{REMOVAL_ATTEMPTS} failed: {exc}",
                        "warn",
                    )
                    status, detail = "failed", last_exc
                    if attempt < REMOVAL_ATTEMPTS:
                        await _interruptible_sleep(random.uniform(2.0, 4.0))

            if STOP.is_set() and status == "failed" and not detail:
                break

            LEDGER.append(url, status, detail)
            STATE.processed += 1
            if status in ("success", "already_removed"):
                STATE.success += 1
                BUS.log(f"  ✓ {status} ({detail})", "success")
            else:
                STATE.failed += 1
                BUS.log(f"  ✗ failed: {detail}", "error")
            push_progress()

            if idx < len(queue) and not STOP.is_set():
                delay = random.uniform(MIN_DELAY_S, MAX_DELAY_S)
                BUS.log(f"  waiting {delay:.1f}s")
                await _interruptible_sleep(delay)

        BUS.log(
            f"Run finished — {STATE.success} removed, {STATE.failed} failed, "
            f"{STATE.skipped} skipped.",
            "success",
        )
    except Exception as exc:
        STATE.last_error = str(exc)
        BUS.log(f"Run aborted: {exc}", "error")
    finally:
        STATE.current_url = ""
        STATE.phase = "idle"
        push_progress()


async def _start_job(coro) -> None:
    global CURRENT_TASK
    running = CURRENT_TASK is not None and not CURRENT_TASK.done()
    if JOB_LOCK.locked() or running:
        coro.close()
        raise HTTPException(409, "Another operation is already running.")

    async def runner():
        async with JOB_LOCK:
            STOP.clear()
            await coro

    CURRENT_TASK = asyncio.create_task(runner())


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Bind the sync primitives to the loop uvicorn actually runs.
    global STOP, JOB_LOCK
    STOP = asyncio.Event()
    JOB_LOCK = asyncio.Lock()
    BUS.log(f"Server listening on http://{HOST}:{PORT} (localhost only)")
    yield
    STOP.set()
    await TT.close()


app = FastAPI(title="TikTok Repost Remover", lifespan=lifespan)


class RemoveRequest(BaseModel):
    cap: int = DEFAULT_CAP


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/status")
async def api_status():
    snap = STATE.snapshot(TT.logged_in, TT.is_open)
    snap["username"] = TT.username
    return snap


@app.post("/api/login")
async def api_login():
    await _start_job(job_login())
    return {"ok": True}


@app.post("/api/check-login")
async def api_check_login():
    if JOB_LOCK.locked():
        raise HTTPException(409, "Busy.")
    await TT.launch()
    ok = await TT.check_login()
    push_progress()
    return {"logged_in": ok, "username": TT.username}


@app.post("/api/scan")
async def api_scan():
    await _start_job(job_scan())
    return {"ok": True}


@app.get("/api/reposts")
async def api_reposts():
    return {"urls": STATE.scanned, "count": len(STATE.scanned)}


@app.post("/api/remove")
async def api_remove(req: RemoveRequest):
    if not STATE.scan_complete:
        raise HTTPException(400, "Run a scan first.")
    cap = max(1, min(req.cap, 10_000))
    await _start_job(job_remove(cap))
    return {"ok": True, "cap": cap}


@app.post("/api/stop")
async def api_stop():
    STOP.set()
    STATE.phase = "stopping" if JOB_LOCK.locked() else "idle"
    BUS.log("Stop requested.", "warn")
    push_progress()
    return {"ok": True}


@app.get("/api/events")
async def api_events():
    q = BUS.subscribe()

    async def gen():
        try:
            yield f"data: {json.dumps({'kind': 'log', 'message': 'connected', 'level': 'info', 'ts': now_iso()})}\n\n"
            snap = STATE.snapshot(TT.logged_in, TT.is_open)
            snap["kind"] = "progress"
            yield f"data: {json.dumps(snap)}\n\n"
            while True:
                try:
                    evt = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {json.dumps(evt)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            BUS.unsubscribe(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def _open_browser_soon() -> None:
    def go():
        time.sleep(1.2)
        try:
            webbrowser.open(f"http://{HOST}:{PORT}")
        except Exception:
            pass

    threading.Thread(target=go, daemon=True).start()


def main() -> None:
    import uvicorn

    if not (STATIC_DIR / "index.html").exists():
        sys.exit(f"Missing {STATIC_DIR / 'index.html'}")
    if os.environ.get("TTRR_NO_BROWSER") != "1":
        _open_browser_soon()
    # host is hard-coded: localhost only, never 0.0.0.0.
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
