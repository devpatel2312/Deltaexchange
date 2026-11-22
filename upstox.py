"""Upstox NSE option chain with automatic login (mobile -> TOTP -> PIN), stdlib + Playwright.

Configured through environment variables (the server .env file, or a local .env file):
  UPSTOX_API_KEY, UPSTOX_API_SECRET, UPSTOX_REDIRECT_URI (must match the Upstox app),
  UPSTOX_MOBILE, UPSTOX_PIN, UPSTOX_TOTP_SECRET, optional UPSTOX_HEADLESS (default true).

Upstox tokens expire around 3:30 AM IST. When the saved token is rejected, the next
request logs in again. Logins are throttled so a public site can't trigger repeated
attempts and get the Upstox account locked.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse, parse_qs
from urllib.request import Request, urlopen
import base64, gzip, hashlib, hmac, json, os, re, shutil, struct, subprocess, threading, time, zlib

ROOT = Path(__file__).resolve().parent


def _load_dotenv():
    """Read KEY=VALUE lines from .env (real environment variables take precedence)."""
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()
e = os.environ.get
API_KEY, API_SECRET = e("UPSTOX_API_KEY"), e("UPSTOX_API_SECRET")
REDIRECT_URI = e("UPSTOX_REDIRECT_URI", "http://127.0.0.1:5000/")
MOBILE, PIN, TOTP_SECRET = e("UPSTOX_MOBILE"), e("UPSTOX_PIN"), e("UPSTOX_TOTP_SECRET")
HEADLESS = e("UPSTOX_HEADLESS", "true").lower() != "false"
DATA_DIR = Path(e("DATA_DIR", ROOT))
TOKEN_FILE = DATA_DIR / "upstox_token.json"
IST = timezone(timedelta(hours=5, minutes=30))
BASE = "https://api.upstox.com"
DIALOG = BASE + "/v2/login/authorization/dialog"
INSTRUMENTS_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz"
INDICES = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"]
STEP_TIMEOUT = 25            # seconds per login step
MIN_LOGIN_GAP = 120          # seconds between any two login attempts
FAIL_COOLDOWN = 600          # seconds to wait after a failed login
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

# Comma-separated alternatives; the first visible match is used.
SEL = dict(
    mobile="#mobileNum, input[placeholder*='10 digit' i]",
    get_otp="#getOtp, button:has-text('Get OTP')",
    otp="#otpNum, input[autocomplete='one-time-code'], input[name*='otp' i], input[placeholder*='otp' i]",
    otp_continue="#continueBtn, button:has-text('Continue'), button[type=submit]",
    pin="#pinCode, input[type=password], input[name*='pin' i], input[placeholder*='pin' i]",
    pin_continue="#pinContinueBtn, button:has-text('Continue'), button[type=submit]",
)


class UpstoxError(RuntimeError):
    pass


def configured():
    return all([API_KEY, API_SECRET, MOBILE, PIN, TOTP_SECRET])


# ---------- HTTP helpers ----------

def _http(url, data=None, headers=None, timeout=20):
    """Return (status, parsed JSON or text). Never raises for HTTP error statuses."""
    body = urlencode(data).encode() if data is not None else None
    req = Request(url, data=body, headers={"Accept": "application/json", "User-Agent": UA, **(headers or {})})
    try:
        with urlopen(req, timeout=timeout) as r:
            status, raw = r.status, r.read()
    except HTTPError as err:
        status, raw = err.code, err.read()
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw.decode("utf-8", "replace")


# ---------- TOTP (RFC 6238, same as authenticator apps) ----------

_last_totp = None


def _totp_at(t):
    secret = TOTP_SECRET.replace(" ", "").upper()
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack(">Q", int(t // 30)), hashlib.sha1).digest()
    off = digest[-1] & 15
    return "%06d" % ((struct.unpack(">I", digest[off:off + 4])[0] & 0x7FFFFFFF) % 1000000)


def _fresh_totp():
    """Current code, never reusing the previous one and never one about to expire."""
    global _last_totp
    left = 30 - time.time() % 30
    if left < 5 or _totp_at(time.time()) == _last_totp:
        time.sleep(left + 1)
    _last_totp = _totp_at(time.time())
    return _last_totp


# ---------- Browser login ----------

_xvfb = None
_diag = {}


def _use_headless():
    """A visible browser needs a display. On a Linux server without one, start a virtual
    display (Xvfb) and wait until it's ready; fall back to headless if that fails."""
    global _xvfb
    if HEADLESS or os.name == "nt":
        return HEADLESS
    if os.environ.get("DISPLAY") and _xvfb is None:
        return False                                   # a real desktop display
    sock = "/tmp/.X11-unix/X99"
    if _xvfb is None or _xvfb.poll() is not None or not os.path.exists(sock):
        if not shutil.which("Xvfb"):
            print("Upstox: Xvfb not installed - using headless browser")
            return True
        log = open("/tmp/xvfb.log", "w")
        _xvfb = subprocess.Popen(["Xvfb", ":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"],
                                 stdout=log, stderr=log)
        end = time.time() + 10
        while time.time() < end and not os.path.exists(sock) and _xvfb.poll() is None:
            time.sleep(0.2)
        if not os.path.exists(sock):
            print("Upstox: virtual display failed to start - using headless browser. Xvfb log:",
                  open("/tmp/xvfb.log").read()[-500:])
            return True
    os.environ["DISPLAY"] = ":99"
    return False


def _fetch_code():
    from playwright.sync_api import sync_playwright  # imported lazily: only needed when logging in
    url = DIALOG + "?" + urlencode(dict(client_id=API_KEY, redirect_uri=REDIRECT_URI, response_type="code"))
    got = {}

    def on_request(req):
        if req.url.startswith(REDIRECT_URI) and "code=" in req.url:
            got["code"] = parse_qs(urlparse(req.url).query)["code"][0]

    with sync_playwright() as p:
        launch = lambda headless: p.chromium.launch(
            headless=headless, channel="chromium",   # "chromium" channel = new headless mode (full browser)
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox",
                  "--disable-dev-shm-usage", "--disable-gpu"])
        headless = _use_headless()
        try:
            browser = launch(headless)
        except Exception as exc:
            if headless:
                raise
            _diag["headed_launch_error"] = str(exc)[-400:]
            print("Upstox: visible browser failed to start - retrying headless")
            browser = launch(True)
        _diag["last_mode"] = "headless" if headless or "headed_launch_error" in _diag else "visible"
        try:
            page = browser.new_page(user_agent=UA, viewport={"width": 1280, "height": 800})
            # Skip images/fonts/media to keep memory low on small hosts.
            page.route("**/*", lambda r: r.abort() if r.request.resource_type in ("image", "font", "media") else r.continue_())
            page.on("request", on_request)
            page.goto(url)

            loc = lambda k: page.locator(SEL[k]).first

            def visible(k):
                try:
                    return loc(k).is_visible()
                except Exception:
                    return False

            def fail(label):
                try:
                    page.screenshot(path=str(DATA_DIR / f"upstox_fail_{label.split()[0]}.png"))
                    info = page.evaluate("""() => ({url: location.href.split('?')[0],
                        text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300)})""")
                except Exception as exc:
                    info = f"(could not inspect page: {exc})"
                raise UpstoxError(f"Login stuck at '{label}'. Page: {info}")

            def wait_until(cond, label):
                end = time.time() + STEP_TIMEOUT
                while time.time() < end:
                    if cond():
                        return
                    page.wait_for_timeout(300)
                fail(label)

            def submit(k):
                try:
                    loc(k).click(timeout=5000)
                except Exception:
                    page.keyboard.press("Enter")

            # 1. mobile number
            wait_until(lambda: visible("mobile"), "mobile")
            loc("mobile").fill(MOBILE)
            submit("get_otp")
            # 2. TOTP (pick the authenticator option if the page offers one)
            wait_until(lambda: visible("otp"), "otp")
            try:
                el = page.get_by_text(re.compile(r"authenticator|totp", re.I)).first
                if el.is_visible():
                    el.click(timeout=2000)
                    page.wait_for_timeout(500)
            except Exception:
                pass
            loc("otp").fill(_fresh_totp())
            page.wait_for_timeout(500)
            submit("otp_continue")
            page.wait_for_timeout(3000)
            # 3. PIN (OTP box must be gone so a password-type OTP box isn't mistaken for it)
            wait_until(lambda: bool(got) or (visible("pin") and not visible("otp")), "pin (OTP may have been rejected)")
            if not got:
                loc("pin").click()
                page.keyboard.type(PIN, delay=60)
                submit("pin_continue")
            # 4. redirect carrying ?code=
            wait_until(lambda: bool(got), "redirect")
        finally:
            browser.close()
    return got["code"]


_login_lock = threading.Lock()
_token_lock = threading.Lock()
_state = {"last_attempt": 0.0, "last_error": None, "token": None}


def login():
    with _login_lock:
        now = time.time()
        wait = (FAIL_COOLDOWN if _state["last_error"] else MIN_LOGIN_GAP) - (now - _state["last_attempt"])
        if wait > 0:
            if _state["last_error"]:
                raise UpstoxError(f"Last Upstox login failed ({_state['last_error'][:200]}). Next attempt allowed in {int(wait)}s.")
            raise UpstoxError(f"Upstox login was attempted moments ago. Try again in {int(wait)}s.")
        _state["last_attempt"] = now
        try:
            code = None
            for attempt in (1, 2):
                try:
                    code = _fetch_code()
                    break
                except UpstoxError:
                    if attempt == 2:
                        raise
                    print("Upstox login attempt 1 failed - retrying once")
            status, body = _http(BASE + "/v2/login/authorization/token", data=dict(
                code=code, client_id=API_KEY, client_secret=API_SECRET,
                redirect_uri=REDIRECT_URI, grant_type="authorization_code"))
            if status != 200 or not isinstance(body, dict) or "access_token" not in body:
                raise UpstoxError(f"Token exchange failed ({status}): {str(body)[:200]}")
        except Exception as exc:
            _state["last_error"] = str(exc)
            raise
        _state.update(last_error=None, token=body["access_token"])
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        TOKEN_FILE.write_text(json.dumps({"token": body["access_token"], "saved_at": datetime.now(IST).isoformat(timespec="seconds")}))
        print("Upstox: new access token saved")
        return body["access_token"]


def _cached_token():
    if _state["token"]:
        return _state["token"]
    try:
        _state["token"] = json.loads(TOKEN_FILE.read_text())["token"]
    except Exception:
        pass
    return _state["token"]


def get_token(force=False):
    if not configured():
        raise UpstoxError("Upstox is not configured. Set the UPSTOX_* environment variables on the server.")
    with _token_lock:
        t = _cached_token()
        if t and not force:
            return t
        _state["token"] = None
        return login()


def up_get(path, params):
    """GET with automatic (re)login: a rejected token triggers one login and a retry."""
    for force in (False, True):
        token = get_token(force=force)
        status, body = _http(BASE + path + "?" + urlencode(params),
                             headers={"Authorization": f"Bearer {token}"})
        if status != 401:
            return status, body
    return status, body


# ---------- Instrument master (streamed: the full file needs ~200 MB if parsed at once) ----------

_inst_lock = threading.Lock()
_inst = {}
_OBJ = re.compile(rb"\{[^{}]*\}")


def _iter_fo_options(gz_bytes):
    """Yield NSE_FO CE/PE records without materialising the whole 43 MB JSON."""
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    buf = b""
    pos = 0
    while True:
        chunk = gz_bytes[pos:pos + (1 << 16)]
        pos += 1 << 16
        buf += d.decompress(chunk) if chunk else d.flush()
        last = 0
        for m in _OBJ.finditer(buf):
            last = m.end()
            s = m.group()
            if b'"NSE_FO"' in s and (b'"CE"' in s or b'"PE"' in s):
                x = json.loads(s)
                if x.get("segment") == "NSE_FO" and x.get("instrument_type") in ("CE", "PE"):
                    yield x
        buf = buf[last:]
        if not chunk:
            break


def load_instruments():
    today = datetime.now(IST).date()
    with _inst_lock:
        if _inst.get("day") == today:
            return _inst
        cache = DATA_DIR / f"upstox-NSE-{today}.json.gz"
        if cache.exists():
            raw = cache.read_bytes()
        else:
            with urlopen(Request(INSTRUMENTS_URL, headers={"User-Agent": UA}), timeout=120) as r:
                raw = r.read()
            for old in DATA_DIR.glob("upstox-NSE-*.json.gz"):
                old.unlink(missing_ok=True)
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(raw)
        keys, stocks, exps, lots = {}, set(), {}, {}
        for x in _iter_fo_options(raw):
            sym, uk = x["underlying_symbol"], x["underlying_key"]
            keys[sym] = uk
            lots[uk] = x.get("lot_size")
            if x.get("underlying_type") == "EQUITY":
                stocks.add(sym)
            exps.setdefault(uk, set()).add(datetime.fromtimestamp(x["expiry"] / 1000, IST).date())
        del raw
        _inst.clear()
        _inst.update(day=today, keys=keys, stocks=sorted(stocks), exps=exps, lots=lots)
        return _inst


def stocks():
    return load_instruments()["stocks"]


# ---------- Option chain ----------

_chain_cache = {}


def _side(o):
    m = (o or {}).get("market_data") or {}
    g = (o or {}).get("option_greeks") or {}
    ltp, close, oi, poi = m.get("ltp"), m.get("close_price"), m.get("oi"), m.get("prev_oi")
    chg = ltp - close if ltp is not None and close else None
    coi = oi - poi if oi is not None and poi is not None else None
    delta = g.get("delta")
    return dict(oi=oi, coi=coi, coi_pct=coi / poi * 100 if coi is not None and poi else None,
                volume=m.get("volume"), iv=g.get("iv"), bid_size=m.get("bid_qty"), bid=m.get("bid_price"),
                ask=m.get("ask_price"), ask_size=m.get("ask_qty"), ltp_change=chg,
                ltp_change_pct=chg / close * 100 if chg is not None else None, ltp=ltp, prev_close=close,
                delta=delta, gamma=g.get("gamma"), theta=g.get("theta"), vega=g.get("vega"),
                custom_oi=abs(delta) * oi if delta is not None and oi is not None else None)


def chain(symbol="NIFTY", expiry=""):
    sym = (symbol or "NIFTY").upper().strip()
    inst = load_instruments()
    ukey = inst["keys"].get(sym)
    if not ukey:
        raise UpstoxError(f"'{sym}' is not an NSE F&O symbol")
    today = datetime.now(IST).date()
    exps = [d.isoformat() for d in sorted(inst["exps"].get(ukey, ())) if d >= today]
    if not exps:
        raise UpstoxError("No upcoming expiries found")
    expiry = expiry if expiry in exps else exps[0]
    hit = _chain_cache.get((ukey, expiry))
    if hit and time.time() - hit[0] < 8:
        return hit[1]
    status, body = up_get("/v2/option/chain", {"instrument_key": ukey, "expiry_date": expiry})
    if status != 200 or not isinstance(body, dict):
        raise UpstoxError(f"Upstox API {status}: {str(body)[:200]}")
    data = body.get("data") or []
    if not data:
        raise UpstoxError("Upstox returned an empty option chain (market data may be unavailable)")
    out = dict(symbol=sym, expiry=expiry, expiries=exps, spot=data[0].get("underlying_spot_price"),
               lot_size=inst["lots"].get(ukey), pcr=data[0].get("pcr"),
               updated=datetime.now(timezone.utc).isoformat(timespec="seconds"),
               rows=[dict(strike=x["strike_price"], Call=_side(x.get("call_options")),
                          Put=_side(x.get("put_options"))) for x in data])
    _chain_cache[(ukey, expiry)] = (time.time(), out)
    return out


def status():
    xlog = ""
    try:
        xlog = open("/tmp/xvfb.log").read()[-400:]
    except OSError:
        pass
    return {"configured": configured(), "logged_in": bool(_cached_token()),
            "last_error": _state["last_error"],
            "browser": {**_diag, "display": os.environ.get("DISPLAY"),
                        "xvfb_running": _xvfb is not None and _xvfb.poll() is None,
                        "xvfb_socket": os.path.exists("/tmp/.X11-unix/X99"), "xvfb_log": xlog}}


def start_background():
    """Warm the instrument cache, and log in before market open on weekdays (08:30 IST)."""
    if not configured():
        return

    def warm():
        try:
            load_instruments()
        except Exception as exc:
            print("Upstox instruments load failed:", exc)

    def scheduler():
        while True:
            now = datetime.now(IST)
            target = now.replace(hour=8, minute=30, second=0, microsecond=0)
            if target <= now:
                target += timedelta(days=1)
            time.sleep((target - now).total_seconds())
            if target.weekday() < 5:
                try:
                    get_token(force=True)
                except Exception as exc:
                    print("Upstox scheduled login failed:", exc)

    threading.Thread(target=warm, daemon=True).start()
    threading.Thread(target=scheduler, daemon=True).start()
