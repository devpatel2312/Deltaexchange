# Official Playwright image: Chromium and its libraries preinstalled, built for x86 and ARM.
FROM mcr.microsoft.com/playwright/python:v1.49.1-noble

ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
# The image already ships Playwright; install only if missing (Ubuntu 24 needs --break-system-packages).
RUN (python3 -c "import playwright" || pip install --no-cache-dir --break-system-packages -r requirements.txt) \
 && apt-get update && apt-get install -y --no-install-recommends xvfb xauth \
 && rm -rf /var/lib/apt/lists/*

COPY . .
# xvfb-run provides a virtual display, so the visible-browser login (UPSTOX_HEADLESS=false) works on a server.
CMD ["xvfb-run", "-a", "python3", "app.py"]
