# Berto on Google Cloud Run (AI Builder Cup 2026). Build: docker build -t berto .
# Runtime: Gemini (LLM + STT) via GEMINI_API_KEY from Secret Manager; TTS via Google Cloud TTS (service account)
# or edge-tts. MedGemma/llama.cpp and faster-whisper are NOT in this image (local demo only).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
COPY shared ./shared
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 DATA_DIR=/tmp/berto LLM_LOG=/tmp/berto/llm-log.jsonl \
    LLM_PROVIDER=gemini STT_PROVIDER=gemini STT_NO_LOCAL=1 TTS_PROVIDER=google-adc LLM_MIN_FREE_MB=0
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
 && python3 -m venv /app/.venv && /app/.venv/bin/pip install --no-cache-dir edge-tts \
 && apt-get purge -y python3-venv && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
RUN rm -f server/stt_worker.py && mkdir -p /tmp/berto && chown -R node:node /tmp/berto
USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
