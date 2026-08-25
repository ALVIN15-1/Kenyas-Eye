FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY livekit-voice/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY livekit-voice/livekit_voice /app/livekit_voice
COPY livekit-voice/tools.json /app/tools.json
COPY livekit-voice/system-prompt.txt /app/system-prompt.txt

CMD ["python", "-m", "livekit_voice.agent", "start"]
