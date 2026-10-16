# Deploy: GitHub → Render

## 0. Check first (30 seconds)
```bash
python scripts/preflight.py
```
It flags oversized files, wrong upper/lower-case folder names (Render runs Linux, where `CJM` ≠ `cjm`),
runs the import and prints time and peak memory. Fix anything marked `PROBLEM`, then continue.

## 1. Push to GitHub
```bash
git init -b main                      # skip if this folder is already a repo
git add .                             # .gitignore already leaves out .DS_Store, var/, caches, *.sqlite3
git commit -m "Court analytics dashboard"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```
The largest file is under 10 MB, so GitHub's 100 MB limit is not an issue now. If a push is ever rejected
with `GH001: Large files detected`, run `scripts/fix_git_push.sh` (see README). If a push of the CSVs
times out (`HTTP 408/500`, `RPC failed`), run `git config http.postBuffer 524288000` and push again.

## 2. Deploy on Render
1. Render dashboard → **New → Blueprint** → pick the repo. `render.yaml` supplies everything
   (Python 3.12, `pip install -r requirements.txt`, one uvicorn worker, health check `/api/v1/health`).
2. Click **Apply**. The first build takes a few minutes. Open the `onrender.com` URL when it says *Live*.

Or by hand: **New → Web Service**, Build `pip install -r requirements.txt`,
Start `uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 1`, Health check path `/api/v1/health`.

## How startup behaves
* The server **opens its port immediately** and imports the CSVs in the background (about 8 s on a normal CPU,
  longer on the free plan's shared CPU). Until it finishes, `/api/v1/health` answers 200 `{"status":"loading"}`
  so Render marks the deploy healthy, and the page shows "Starting up and loading case data…" and retries by itself.
* Free plan: the service sleeps after ~15 minutes idle; the next visit wakes it and sees that loading screen.
* Memory: about 265 MB peak while importing and about 320 MB when serving (free plan limit is 512 MB).
  Keep `--workers 1`; every extra worker would load its own copy of the data.
* `COURTS_BACKGROUND_LOAD=0` makes the server finish loading before it listens (the old behaviour).

## Adding or updating data
Replace the CSVs under `Source_Data_For_Analysis/<District>/…`, run `python scripts/preflight.py`, commit and push;
Render redeploys automatically. Keep every file under 50 MB.
