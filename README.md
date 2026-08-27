# TikTok Repost Remover

A local-only desktop app that removes every repost from your own TikTok
account. It runs on your machine and is never deployed anywhere.

By default it binds `127.0.0.1` only. With `--phone` it serves itself on your
home network so you can **drive it from your iPhone** — see
[Using it from your iPhone](#using-it-from-your-iphone).

**No computer at all?** There's a bookmarklet that runs entirely on the phone,
inside Safari: [`iphone/`](iphone/). Slower and more fragile than this app, but
it needs nothing but the phone.

## What it does

1. Opens a **headed** Chromium window (Playwright) using a persistent profile in
   `./tiktok-profile`, so your login survives restarts.
2. You log in **by hand** in that window. The app never sees, stores, or
   transmits your password — it just polls until a session cookie appears.
3. Scans your profile's **Reposts** tab and collects the complete URL list
   *before* removing anything.
4. Removes them one at a time, in sequence, with a random 3–8 s pause between
   each, verifying that the repost state actually flipped before counting a
   success.

## Requirements

- Python 3.11
- A desktop session (the browser is never headless)

## Run it

```bash
./run.sh          # macOS / Linux — double-clickable
run.bat           # Windows — double-clickable
```

Either script creates `.venv`, installs dependencies, downloads Chromium on
first run, and then starts the app. If you'd rather do it yourself:

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium
python app.py
```

`python app.py` is the single entry point: it starts the server on
<http://127.0.0.1:8731> and opens that URL in your default browser.

## Using it from your iPhone

```bash
./run-phone.sh    # macOS / Linux — double-clickable
run-phone.bat     # Windows — double-clickable
# same as: python app.py --phone
```

The terminal prints a QR code and a URL. Point your iPhone camera at the QR,
tap the banner, and the full UI opens in Safari — status, scan, remove, live
progress, log, all of it. The computer's own browser opens the same page, with
an **Open on your phone** panel showing the QR again.

For a more app-like feel: Safari → Share → **Add to Home Screen**. It launches
full-screen with no address bar.

### What the phone can and can't do

The phone is a **remote control**, not the worker. Playwright drives a real
Chromium window on your computer — there's no iOS equivalent, and the TikTok
iOS app can't be automated. So the computer must stay awake and running the
app; the phone starts, watches, and stops the run.

That also means the first login has to happen at the computer, since that's
where the browser window opens.

### How `--phone` is secured

- Binds **your machine's own LAN address**, e.g. `192.168.1.x` — never
  `0.0.0.0`, so it's on one interface, not every one.
- Every request needs a random access code generated fresh at each start. Quit
  the app and old links are dead. The code lives in the QR link, then in a
  same-origin `HttpOnly` cookie.
- Requests with a `Host` header that isn't the bound address are rejected, so a
  hostile web page can't reach the API through DNS rebinding.
- It's still HTTP on your own LAN — fine for a home network, not something to
  expose to the internet. Don't port-forward it. On public Wi-Fi, stick to
  plain `python app.py`.

To reach it from *outside* your home, don't open a port — put the machine and
the phone on a [Tailscale](https://tailscale.com) network and use the machine's
Tailscale IP. Nothing about the app has to change.

`python app.py` with no flag is completely unchanged: loopback only, no token,
nothing off the machine can connect.

## Using it

- **Log in to TikTok** — opens `tiktok.com/login` in the automated window. Log
  in there; the status line flips to *Logged in* on its own.
- **Scan reposts** — loads your profile, opens the Reposts tab, scrolls to the
  end and lists every repost URL it finds.
- **Remove all** — enabled only after a scan. Shows a confirmation with the
  count, then works through the list.
- **Stop** — halts cleanly: the current removal finishes or aborts, and the run
  ends without starting another.
- The log pane streams backend events live over Server-Sent Events.

### Cap per run

Defaults to 200 removals per run, editable in the UI. Anything beyond the cap is
left for the next run — scan again and go.

### `removed.jsonl`

Every attempt is appended as one JSON object: `url`, `timestamp`, `status`
(`success`, `already_removed`, or `failed`) and a short `detail`.

On later runs, URLs already logged as `success` / `already_removed` are skipped.
URLs logged as `failed` **are** retried — that's the point of keeping them.

### Failures

Each removal is retried up to 3 times before it's marked `failed`. A failure
never kills the run; the app logs it and moves to the next URL.

## When TikTok changes its DOM (it will)

Every selector lives in the `SELECTORS` dict at the top of `app.py`, and each
entry is an ordered list of candidates tried in turn. If the app suddenly finds
0 reposts or can't find the repost button, add a new selector to the top of the
relevant list — nothing else in the code needs to change. Prefer stable
`data-e2e="..."` attributes over hashed CSS class names.

If TikTok throws a captcha, the run stops with a clear error. Solve it in the
browser window and start again.

## Deliberate non-features

No accounts, no multi-user, no password storage of any kind, no headless mode,
and no public deployment — the automation and your TikTok session never leave
this computer.

`--phone` adds exactly one thing to that list: a single shared access code, so
that serving the page on your LAN doesn't hand the controls to everything else
on the Wi-Fi. It's a door key for the one person using this, not a login
system. Without `--phone` there is no token and no LAN listener at all.

## Caution

Removing reposts is irreversible from this app's side, and heavy automation can
draw TikTok's rate limiting. The delays and the per-run cap exist for that
reason; leaving them at the defaults is the sane choice.
