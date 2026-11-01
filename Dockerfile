# Single container: FastAPI + static PWA, SQLite on a mounted volume.
# Reachable over Tailscale only — no public ingress, no TLS here (BRIEF §11).

FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# sqlite3 CLI is needed by the nightly `.backup` job; tzdata so local dates
# resolve correctly — the whole daily-aggregation model depends on it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends sqlite3 tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so code edits do not invalidate the layer.
COPY pyproject.toml ./
COPY ledger/__init__.py ./ledger/
RUN pip install --no-cache-dir .

COPY ledger/ ./ledger/
COPY scripts/ ./scripts/
RUN pip install --no-cache-dir --no-deps -e . && chmod +x scripts/*.sh

# Data and tokens live on volumes, never in the image.
ENV LEDGER_DB_PATH=/data/ledger.db \
    LEDGER_BACKUP_DIR=/backups \
    GARMINTOKENS=/tokens \
    TZ=America/New_York

# Run unprivileged. The mount points are created owned by this user so a fresh
# named volume inherits that ownership; volumes created by older root-run
# images are re-owned once by the compose `volume-perms` service.
RUN useradd --system --uid 10001 --user-group --home-dir /home/ledger --create-home ledger \
 && mkdir -p /data /backups /tokens \
 && chown ledger:ledger /data /backups /tokens
USER 10001:10001

VOLUME ["/data", "/backups", "/tokens"]
EXPOSE 8000

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=4).status==200 else 1)"

CMD ["uvicorn", "ledger.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
