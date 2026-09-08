# Saily chart service. Build from the repository root:
#   docker build -f server/Dockerfile -t saily-chart-service .
#   docker run --rm -p 8787:8787 -v saily-jobs:/jobs saily-chart-service
FROM python:3.12-slim

# shapely ships manylinux wheels, so no compiler is needed; curl is here for the container health check.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# dependencies first, so editing the app does not re-resolve them
COPY tools/requirements.txt tools/requirements.txt
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

# only what a build needs: the tools, the schemas, and the service
COPY tools/ tools/
COPY schema/ schema/
COPY server/ server/

RUN useradd --system --uid 10001 saily && mkdir -p /jobs && chown saily /jobs
USER saily

ENV PORT=8787 \
    SAILY_JOBS_DIR=/jobs \
    PYTHONUNBUFFERED=1
EXPOSE 8787
VOLUME ["/jobs"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

# One worker on purpose: the concurrency cap is per process. Raise SAILY_MAX_RUNNING to build more at once.
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT} --workers 1 --threads 8 --timeout 120 --access-logfile - server.wsgi:app"]
