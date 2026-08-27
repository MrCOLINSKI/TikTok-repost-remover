# TikTok Repost Remover

A local-only desktop app that removes every repost from your own TikTok
account. It runs on your machine, binds to `127.0.0.1` only, and is never
deployed anywhere.

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

No auth, no accounts, no multi-user — it's one person on localhost. No password
storage of any kind. No headless mode. No binding to anything but `127.0.0.1`.

## Caution

Removing reposts is irreversible from this app's side, and heavy automation can
draw TikTok's rate limiting. The delays and the per-run cap exist for that
reason; leaving them at the defaults is the sane choice.
