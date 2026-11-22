# Official Playwright image: Chromium and its libraries preinstalled, built for x86 and ARM.
FROM mcr.microsoft.com/playwright/python:v1.49.1-noble

# HOST=0.0.0.0 so the server is reachable from outside the container; Render overrides PORT.
ENV PYTHONUNBUFFERED=1 HOST=0.0.0.0 PORT=10000
WORKDIR /app
COPY requirements.txt .
# Xvfb gives the visible-browser login (UPSTOX_HEADLESS=false) a virtual display; upstox.py starts it on demand.
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt \
 && apt-get update && apt-get install -y --no-install-recommends xvfb \
 && rm -rf /var/lib/apt/lists/*

COPY . .
EXPOSE 10000
CMD ["python3", "app.py"]
