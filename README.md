# Delta Options Desk

A responsive BTC/ETH options dashboard using Delta Exchange India's official public API (`https://api.india.delta.exchange`). This first build is a read-only market dashboard: it does not use private account or order endpoints.

## Run

1. Install Python 3.10+.
2. Start the app with `python app.py` and open http://127.0.0.1:8501. No third-party Python packages are required.

The dashboard refreshes every 15 seconds. Its default option-chain columns are Delta, custom Delta, LTP change and LTP on each side, with strike in the center. You can choose BTC or ETH, select an expiry, show/hide additional chain columns, and switch the highlights between the highest/lowest two or three values in each numeric column. IV history and cached previous UTC daily closes are saved to `market_history.sqlite3`.

**LTP change** uses the official 1-day historical candle close as the previous UTC day close and displays both the price change and percentage change. If that candle is missing, the cell uses Delta's rolling `ltp_change_24h` ticker field, marked as a 24-hour fallback. **Custom Δ** is the displayed index price change divided by the displayed option LTP change. It is blank when either change is unavailable or the option LTP change is zero. This custom ratio is distinct from Delta Exchange's Greek delta.

The dashboard requires an internet connection to reach Delta's official API. It does not fabricate prices if the feed is unavailable.

## Publish on Render (free)

`render.yaml` is a Render Blueprint for a free Docker web service named `delta-desk`. In Render choose **New → Blueprint**, pick this repository, and fill in the `UPSTOX_*` values when asked. Free services sleep after 15 idle minutes; a free uptime monitor requesting `/api/upstox/status` every 5–10 minutes keeps it awake. The free disk is wiped on restarts, so nothing is stored long term there.

## Publish on a VPS (Hostinger, Oracle Cloud, ...)

The site can also run on any Ubuntu **VPS** (shared or web hosting plans can't run it: it needs a long-running Python server and a Chromium browser). It runs in Docker with Caddy in front, restarts automatically, and keeps all data in `~/delta-desk/data` on the server, so history survives restarts and redeploys.

1. Create a VPS with **Ubuntu 24.04** (at least 2 GB RAM) and add your SSH public key.
2. Put your Upstox settings in `.env` (see `.env.example`).
3. From this folder, run `bash deploy/deploy.sh root@YOUR_VPS_IP`. It installs Docker on first run, copies the app and `.env`, and starts it. Re-run it to deploy changes.
4. Open `http://YOUR_VPS_IP`. For HTTPS, point a domain's A record at the VPS and add `SITE_ADDRESS=yourdomain.com` to your local `.env` (the deploy copies it to the server), then re-run the deploy; Caddy obtains the certificate automatically.

## NSE option chain (Upstox)

`/upstox` shows the NSE index and stock option chain from the Upstox API. The server logs in to Upstox by itself (mobile → TOTP → PIN in a hidden Chromium browser via Playwright) and saves the token as `upstox_token.json` in `DATA_DIR`. Tokens expire around 3:30 AM IST; the next request after that logs in again, and the server also logs in at 08:30 IST on weekdays while it is awake.

Set these environment variables (copy `.env.example` to `.env`; the deploy script sends it to the server):
`UPSTOX_API_KEY`, `UPSTOX_API_SECRET`, `UPSTOX_REDIRECT_URI` (exactly the redirect URL registered in the Upstox app), `UPSTOX_MOBILE`, `UPSTOX_PIN`, `UPSTOX_TOTP_SECRET`.

Logins are throttled (at most one every 2 minutes, and 10 minutes after a failure) so visitors to the public site cannot trigger repeated attempts that could lock the Upstox account. If a login fails, the error is shown on the page and a screenshot is saved as `upstox_fail_<step>.png` in `DATA_DIR`.

Local run: `pip install -r requirements.txt`, `playwright install chromium`, then `python app.py`. The Delta pages still work without these packages; only the Upstox login needs them.

On the server the app runs from the `Dockerfile`, which is based on the official Playwright image (Chromium and its libraries included).
