# Delta Options Desk

A responsive BTC/ETH options dashboard using Delta Exchange India's official public API (`https://api.india.delta.exchange`). This first build is a read-only market dashboard: it does not use private account or order endpoints.

## Run

1. Install Python 3.10+.
2. Start the app with `python app.py` and open http://127.0.0.1:8501. No third-party Python packages are required.

The dashboard refreshes every 15 seconds. Its default option-chain columns are Delta, custom Delta, LTP change and LTP on each side, with strike in the center. You can choose BTC or ETH, select an expiry, show/hide additional chain columns, and switch the highlights between the highest/lowest two or three values in each numeric column. IV history and cached previous UTC daily closes are saved to `market_history.sqlite3`.

**LTP change** uses the official 1-day historical candle close as the previous UTC day close and displays both the price change and percentage change. If that candle is missing, the cell uses Delta's rolling `ltp_change_24h` ticker field, marked as a 24-hour fallback. **Custom Δ** is the displayed index price change divided by the displayed option LTP change. It is blank when either change is unavailable or the option LTP change is zero. This custom ratio is distinct from Delta Exchange's Greek delta.

The dashboard requires an internet connection to reach Delta's official API. It does not fabricate prices if the feed is unavailable.

## Publish as a live site

The repository includes a Render Blueprint in `render.yaml`. In Render, create a new Blueprint deployment from this GitHub repository and deploy the `delta-options-desk` web service. Render assigns the public URL after deployment. The app listens on Render's `PORT` and binds to `0.0.0.0` when hosted.

The free service uses an ephemeral filesystem, so the SQLite IV history is not retained across redeploys or restarts. For persistent history, attach a persistent disk and set `DATA_DIR` to its mount path in the hosting service.
