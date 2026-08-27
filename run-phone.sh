#!/usr/bin/env bash
# Double-click me to run the app so you can open it on your iPhone.
# Same app as run.sh, but served on your home network with an access code.
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
if [ ! -d .venv ]; then
  echo "Creating virtualenv…"
  "$PY" -m venv .venv
  ./.venv/bin/pip install --upgrade pip
  ./.venv/bin/pip install -r requirements.txt
  ./.venv/bin/python -m playwright install chromium
fi

exec ./.venv/bin/python app.py --phone
