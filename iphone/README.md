# iPhone-only: the bookmarklet

No computer? This removes your reposts from the phone itself.

A bookmarklet is a bookmark whose address is JavaScript instead of a web page.
Tapping it runs that code inside whatever page you're looking at. So you open
TikTok in Safari — already logged in — tap the bookmark, and a control panel
slides up from the bottom of the page.

It never sees your password, never talks to any server, and works only on the
tab you run it in.

## Install it (once, about a minute)

1. Open **`bookmarklet.txt`** in this folder, tap and hold, **Select All**,
   **Copy**. Copy every character — it starts with `javascript:` and it's long.
2. In Safari, go to any page and tap **Share → Add Bookmark**. Name it
   *Remove reposts*. Save it to **Favorites** so it's easy to reach.
3. Tap the **bookmarks icon** (open book) → **Edit** → tap your new bookmark.
4. Delete what's in the **address** field and **paste**. Tap **Done**.

If pasting drops the `javascript:` prefix — Safari sometimes strips it — type
those eleven characters back in by hand at the front.

## Use it

1. Safari → **tiktok.com**, logged in.
2. Go to **your own profile** (the URL has to start with `/@`).
3. Tap the bookmarks icon → tap **Remove reposts**. The panel appears.
4. **Scan** — it opens your Reposts tab and scrolls to the bottom collecting
   everything.
5. **Remove all** — confirm the count, then leave it alone and watch.

**Set Auto-Lock to Never first** (Settings → Display & Brightness → Auto-Lock).
Safari pauses timers when the screen locks or you switch apps, which stalls the
run. Keep this tab in the foreground until it finishes.

## What it does, same as the desktop app

- Collects the full list before removing anything.
- One at a time, random 3–8 s gap, never in parallel.
- 3 attempts each, then marks it failed and carries on. One failure never
  kills the run.
- Checks the repost actually flipped off before counting it — a tap that
  silently did nothing counts as a failure, not a success.
- Default cap of 200 per run, editable in the panel.
- Remembers what it removed in this phone's `localStorage`, so a second run
  skips them. Failures get retried.
- **Stop** halts after the current one.

## When it breaks

TikTok changes its DOM often, and the mobile site changes on its own schedule.
Every selector is in the `S` object at the top of `repost-remover.js`, each one
a list of fallbacks. If a scan finds nothing, that's where to look — but
editing JavaScript on a phone is miserable, so realistically this is where you
wait until you can get to a computer and use the real app.

If the panel finds no Reposts tab, or removals all fail with *"repost button
not found"*, try **Request Desktop Website** (from the `aA` menu in the address
bar) and run it again — the desktop layout has a more predictable structure.

## The honest limitations

- Slower and more fragile than the desktop app. The desktop version drives a
  real browser and can verify things this can't.
- Safari can throttle or discard a backgrounded tab, which ends the run early.
  You'll see it stop; scan again and resume.
- It works through TikTok's own modal instead of navigating, because navigating
  away kills the script.

If a run stops early, nothing is lost: the ledger already recorded what came
off, so scan again, tap Remove all, and it picks up where it left off.

## Doing it by hand

If the bookmarklet won't cooperate, the manual route in the TikTok app is:
**Profile → Reposts tab → open a video → Share → Remove repost**. Roughly ten
seconds each, and no automation to break.
