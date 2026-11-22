FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# ffmpeg/libsndfile: audio decoding. git + build-essential: madmom is built from GitHub.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 git build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt requirements-madmom.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir -r requirements-madmom.txt

COPY . .
RUN mkdir -p /app/jobs

EXPOSE 8000
# Hosts like Railway set $PORT; default to 8000 for docker run -p 8000:8000.
ENV PORT=8000
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
