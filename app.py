"""Read-only Delta Exchange India public market dashboard (Python stdlib only)."""
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError, HTTPError
from urllib.parse import urlparse, parse_qs, urlencode
from urllib.request import Request, urlopen
import json
import os
import sqlite3

import upstox

ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get("DATA_DIR", ROOT)) / "market_history.sqlite3"
API = "https://api.india.delta.exchange"


def init_db():
    with sqlite3.connect(DB) as con:
        con.execute("CREATE TABLE IF NOT EXISTS iv_readings (observed_at TEXT NOT NULL, asset TEXT NOT NULL, expiry TEXT NOT NULL, symbol TEXT NOT NULL, strike REAL, option_type TEXT, iv REAL, underlying REAL)")
        con.execute("CREATE INDEX IF NOT EXISTS iv_readings_lookup ON iv_readings(asset, expiry, observed_at)")
        con.execute("CREATE TABLE IF NOT EXISTS daily_closes (symbol TEXT NOT NULL, close_day TEXT NOT NULL, close_price REAL, PRIMARY KEY(symbol, close_day))")


def api_get(path, params=None):
    url = API + path + ("?" + urlencode(params) if params else "")
    req = Request(url, headers={"Accept": "application/json", "User-Agent": "delta-options-dashboard/1.0"})
    with urlopen(req, timeout=12) as response:
        data = json.loads(response.read())
    if not data.get("success"):
        raise RuntimeError(data.get("error", {}).get("message", "Delta API returned an unsuccessful response"))
    return data.get("result", [])


def products(asset):
    return api_get("/v2/products", {"contract_types": "call_options,put_options", "underlying_asset_symbols": asset})


def expiry_of(item):
    return item.get("settlement_time") or item.get("expiry_date") or item.get("expiry")


def expiry_label(value):
    if not value:
        return ""
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).strftime("%d-%m-%Y")
    except ValueError:
        return str(value)[:10]


def expiry_in_future(value):
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt > datetime.now(timezone.utc)
    except ValueError:
        return False


def expiry_order(label):
    try:
        return datetime.strptime(label, "%d-%m-%Y")
    except ValueError:
        return datetime.max


def num(obj, *keys):
    for key in keys:
        val = obj.get(key)
        try:
            if val is not None and val != "":
                return float(val)
        except (TypeError, ValueError):
            pass
    return None


def greek(ticker, name):
    value = num(ticker.get("greeks") or {}, name)
    return value if value is not None else num(ticker, name, f"{name}_greek")


def previous_day_close(symbol, today):
    with sqlite3.connect(DB, timeout=20) as con:
        found = con.execute("SELECT close_price FROM daily_closes WHERE symbol=? AND close_day=?", (symbol, today)).fetchone()
        if found is not None:
            return found[0]
    today_dt = datetime.strptime(today, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    start = int((today_dt.timestamp()) - 86400)
    end = int(today_dt.timestamp())
    try:
        candles = api_get("/v2/history/candles", {"resolution": "1d", "symbol": symbol, "start": start, "end": end})
    except (HTTPError, URLError, TimeoutError, RuntimeError, ValueError):
        return None
    valid = [c for c in candles if int(c.get("time", end)) < end and num(c, "close") is not None]
    close = num(max(valid, key=lambda c: int(c.get("time", 0))), "close") if valid else None
    with sqlite3.connect(DB, timeout=20) as con:
        con.execute("INSERT OR REPLACE INTO daily_closes(symbol,close_day,close_price) VALUES(?,?,?)", (symbol, today, close))
    return close


def previous_24h_close(symbol, now):
    hour_key = f"rolling24h:{now.strftime('%Y-%m-%dT%H')}"
    with sqlite3.connect(DB, timeout=20) as con:
        found = con.execute("SELECT close_price FROM daily_closes WHERE symbol=? AND close_day=?", (symbol, hour_key)).fetchone()
        if found is not None:
            return found[0]
    now_ts = int(now.timestamp())
    target = now_ts - 86400
    try:
        candles = api_get("/v2/history/candles", {"resolution": "5m", "symbol": symbol, "start": target - 900, "end": target + 300})
    except (HTTPError, URLError, TimeoutError, RuntimeError, ValueError):
        return None
    valid = [c for c in candles if int(c.get("time", target + 1)) <= target and num(c, "close") is not None]
    close = num(max(valid, key=lambda c: int(c.get("time", 0))), "close") if valid else None
    with sqlite3.connect(DB, timeout=20) as con:
        con.execute("INSERT OR REPLACE INTO daily_closes(symbol,close_day,close_price) VALUES(?,?,?)", (symbol, hour_key, close))
    return close


def market_data(asset, expiry):
    raw = api_get("/v2/tickers", {"contract_types": "call_options,put_options", "underlying_asset_symbols": asset, "expiry_date": expiry})
    under = api_get("/v2/tickers", {"contract_types": "perpetual_futures", "underlying_asset_symbols": asset})
    index_price = next((num(t, "spot_price") for t in under if num(t, "spot_price") is not None), None)
    close_day = datetime.now(timezone.utc).date().isoformat()
    symbols = [t.get("symbol", "") for t in raw if t.get("symbol")]
    index_symbol = ".DEXBTUSD" if asset == "BTC" else ".DEETHUSD"
    close_symbols = list(dict.fromkeys(symbols + [index_symbol]))
    with ThreadPoolExecutor(max_workers=12) as pool:
        close_values = dict(zip(close_symbols, pool.map(lambda sym: previous_day_close(sym, close_day), close_symbols)))
    index_previous_close = close_values.get(index_symbol)
    index_change = ((index_price - index_previous_close) / index_previous_close * 100) if index_price is not None and index_previous_close else None
    index_previous_24h_close = previous_24h_close(index_symbol, datetime.now(timezone.utc))
    index_change_24h = index_price - index_previous_24h_close if index_price is not None and index_previous_24h_close is not None else None
    rows = []
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for t in raw:
        symbol = t.get("symbol", "")
        strike = num(t, "strike_price", "strike")
        if strike is None:
            try:
                strike = float(symbol.split("-")[2])
            except (IndexError, ValueError):
                pass
        kind = "Call" if "call" in str(t.get("contract_type", "")).lower() or symbol.startswith("C-") else "Put"
        quotes = t.get("quotes") or {}
        iv = num(t, "implied_volatility", "iv")
        if iv is None:
            ivs = [x for x in (num(quotes, "bid_iv"), num(quotes, "ask_iv")) if x is not None]
            iv = sum(ivs) / len(ivs) if ivs else None
        ltp = num(t, "close", "last_traded_price")
        previous_close = close_values.get(symbol)
        ltp_change = ltp - previous_close if ltp is not None and previous_close is not None else None
        ltp_change_pct = (ltp_change / previous_close * 100) if ltp_change is not None and previous_close else None
        change_basis = "previous_utc_close" if ltp_change is not None else None
        rolling_change_pct = num(t, "ltp_change_24h")
        if ltp_change is None and ltp is not None and rolling_change_pct is not None and rolling_change_pct > -100:
            ltp_change_pct = rolling_change_pct
            ltp_change = ltp * rolling_change_pct / (100 + rolling_change_pct)
            change_basis = "rolling_24h_fallback"
        rows.append({"symbol": symbol, "type": kind, "strike": strike, "bid": num(quotes, "best_bid") if num(quotes, "best_bid") is not None else num(t, "best_bid", "bid_price"), "ask": num(quotes, "best_ask") if num(quotes, "best_ask") is not None else num(t, "best_ask", "ask_price"), "bid_size": num(quotes, "bid_size"), "ask_size": num(quotes, "ask_size"), "mark": num(t, "mark_price", "mark_price_usd", "close"), "ltp": ltp, "previous_close": previous_close, "ltp_change": ltp_change, "ltp_change_pct": ltp_change_pct, "ltp_change_basis": change_basis, "iv": iv, "oi": num(t, "oi", "open_interest"), "volume": num(t, "volume", "volume_24h"), "delta": greek(t, "delta"), "gamma": greek(t, "gamma"), "theta": greek(t, "theta"), "vega": greek(t, "vega")})
    displayed_index_move = index_price - index_previous_close if index_price is not None and index_previous_close is not None else None
    for row in rows:
        row["custom_delta"] = displayed_index_move / row["ltp_change"] if displayed_index_move is not None and row["ltp_change"] not in (None, 0) else None
        row["custom_oi"] = abs(row["delta"]) * row["oi"] if row["delta"] is not None and row["oi"] is not None else None
    rows.sort(key=lambda r: (r["strike"] is None, r["strike"] or 0, r["type"]))
    with sqlite3.connect(DB) as con:
        con.executemany("INSERT INTO iv_readings VALUES (?,?,?,?,?,?,?,?)", [(now, asset, expiry, r["symbol"], r["strike"], r["type"], r["iv"], index_price) for r in rows])
    return {"asset": asset, "expiry": expiry, "underlying": index_price, "index_change": index_change, "index_previous_close": index_previous_close, "index_change_24h": index_change_24h, "index_previous_24h_close": index_previous_24h_close, "rows": rows, "updated": now, "source": "Delta Exchange India public API"}


class Handler(BaseHTTPRequestHandler):
    def upstox_api(self, parsed):
        q = parse_qs(parsed.query)
        try:
            if parsed.path == "/api/upstox/chain":
                data = upstox.chain(q.get("symbol", ["NIFTY"])[0], q.get("expiry", [""])[0])
                return self.respond(200, json.dumps(data))
            if parsed.path == "/api/upstox/totals":
                return self.respond(200, json.dumps(upstox.totals(q.get("symbol", ["NIFTY"])[0])))
            if parsed.path == "/api/upstox/symbols":
                return self.respond(200, json.dumps({"indices": upstox.INDICES, "stocks": upstox.stocks()}))
            if parsed.path == "/api/upstox/status":
                return self.respond(200, json.dumps(upstox.status()))
            if parsed.path == "/api/upstox/relogin" and self.command == "POST":
                upstox.get_token(force=True)
                return self.respond(200, json.dumps({"ok": True}))
            return self.respond(404, json.dumps({"error": "Not found"}))
        except upstox.UpstoxError as exc:
            return self.respond(502, json.dumps({"error": str(exc)}))
        except Exception as exc:
            self.log_error("Upstox request failed for %s: %r", parsed.path, exc)
            return self.respond(502, json.dumps({"error": f"Upstox request failed: {exc}"}))

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/upstox/"):
            return self.upstox_api(parsed)
        return self.respond(404, json.dumps({"error": "Not found"}))


    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def respond(self, status, body, content_type="application/json; charset=utf-8"):
        raw = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/":
                return self.respond(200, (ROOT / "templates" / "index.html").read_bytes(), "text/html; charset=utf-8")
            if parsed.path == "/totals":
                return self.respond(200, (ROOT / "templates" / "totals.html").read_bytes(), "text/html; charset=utf-8")
            if parsed.path == "/upstox":
                return self.respond(200, (ROOT / "templates" / "upstox.html").read_bytes(), "text/html; charset=utf-8")
            if parsed.path == "/upstox/totals":
                return self.respond(200, (ROOT / "templates" / "upstox_totals.html").read_bytes(), "text/html; charset=utf-8")
            if parsed.path.startswith("/api/upstox/"):
                return self.upstox_api(parsed)
            if parsed.path in ("/static/style.css", "/static/app.js", "/static/totals.js", "/static/columns.js", "/static/upstox.js", "/static/upstox-columns.js", "/static/upstox-totals.js"):
                file = ROOT / parsed.path.lstrip("/")
                return self.respond(200, file.read_bytes(), "text/css; charset=utf-8" if file.suffix == ".css" else "text/javascript; charset=utf-8")
            if parsed.path == "/api/expiries":
                asset = parse_qs(parsed.query).get("asset", ["BTC"])[0].upper()
                if asset not in {"BTC", "ETH"}:
                    return self.respond(400, json.dumps({"error": "Choose BTC or ETH"}))
                vals = sorted({expiry_label(expiry_of(p)) for p in products(asset) if expiry_of(p) and expiry_in_future(expiry_of(p))}, key=expiry_order)
                return self.respond(200, json.dumps({"expiries": vals}))
            if parsed.path == "/api/totals":
                asset = parse_qs(parsed.query).get("asset", ["BTC"])[0].upper()
                if asset not in {"BTC", "ETH"}:
                    return self.respond(400, json.dumps({"error": "Choose BTC or ETH"}))
                expiries = sorted({expiry_label(expiry_of(p)) for p in products(asset) if expiry_of(p) and expiry_in_future(expiry_of(p))}, key=expiry_order)
                def aggregate(expiry):
                    data = market_data(asset, expiry)
                    rows = data["rows"]
                    calls = [r for r in rows if r["type"] == "Call"]
                    puts = [r for r in rows if r["type"] == "Put"]
                    sum_fields = {"custom_oi", "oi", "volume", "bid_size", "ask_size", "delta", "theta", "vega"}
                    def side_metrics(side_rows):
                        keys = {key for row in side_rows for key, value in row.items() if key not in {"symbol", "type", "strike", "previous_close", "ltp_change_basis"} and isinstance(value, (int, float))}
                        result = {}
                        for key in keys:
                            vals = [row[key] for row in side_rows if isinstance(row.get(key), (int, float))]
                            result[key] = sum(vals) if key in sum_fields else (sum(vals) / len(vals) if vals else None)
                        return result
                    return {"expiry": expiry, "contracts": len(rows), "call": side_metrics(calls), "put": side_metrics(puts)}
                with ThreadPoolExecutor(max_workers=4) as pool:
                    totals = list(pool.map(aggregate, expiries))
                return self.respond(200, json.dumps({"asset": asset, "totals": totals, "updated": datetime.now(timezone.utc).isoformat(timespec="seconds")}))
            if parsed.path == "/api/market":
                q = parse_qs(parsed.query)
                asset, expiry = q.get("asset", ["BTC"])[0].upper(), q.get("expiry", [""])[0]
                if asset not in {"BTC", "ETH"}:
                    return self.respond(400, json.dumps({"error": "Choose BTC or ETH"}))
                return self.respond(200, json.dumps(market_data(asset, expiry)))
            return self.respond(404, json.dumps({"error": "Not found"}))
        except (HTTPError, URLError, TimeoutError, RuntimeError, OSError, ValueError) as exc:
            return self.respond(502, json.dumps({"error": f"Delta API unavailable: {exc}"}))
        except Exception as exc:
            self.log_error("Request failed for %s: %s", parsed.path, exc)
            return self.respond(500, json.dumps({"error": "Market data request failed. Check the server log for details."}))


if __name__ == "__main__":
    DB.parent.mkdir(parents=True, exist_ok=True)
    init_db()
    upstox.start_background()
    port = int(os.environ.get("PORT", "8501"))
    host = os.environ.get("HOST") or ("0.0.0.0" if "PORT" in os.environ else "127.0.0.1")
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Delta Options Desk available on {host}:{port}")
    server.serve_forever()
