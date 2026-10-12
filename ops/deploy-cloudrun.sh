#!/usr/bin/env bash
# Deploy Berto to Google Cloud Run (asia-southeast1). Run AFTER `gcloud auth login` and the one-time setup
# in ops/CLOUDRUN.md (APIs enabled, secret berto-gemini-api-key created). Builds with Cloud Build (no local docker needed).
# Usage: PROJECT_ID=my-project ops/deploy-cloudrun.sh
set -euo pipefail
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-asia-southeast1}"
SERVICE="${SERVICE:-berto}"
REPO="${REPO:-berto}"
TTS="${TTS_PROVIDER:-google-adc}"           # google-adc (Cloud TTS via service account) or edge
GEMINI_MODEL="${GEMINI_MODEL:-gemini-2.5-flash}"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$SERVICE:$(date +%Y%m%d-%H%M%S)"
cd "$(dirname "$0")/.."

gcloud config set project "$PROJECT_ID" >/dev/null
gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPO" --repository-format=docker --location "$REGION" --description "Berto images"
gcloud builds submit --tag "$IMAGE" .

SECRETS="GEMINI_API_KEY=berto-gemini-api-key:latest"
# Optional stable Web Push keys (otherwise each new instance makes new keys and old subscriptions stop working).
if gcloud secrets describe berto-vapid-private >/dev/null 2>&1; then
  SECRETS="$SECRETS,VAPID_PRIVATE_KEY=berto-vapid-private:latest,VAPID_PUBLIC_KEY=berto-vapid-public:latest"
fi

gcloud run deploy "$SERVICE" --image "$IMAGE" --region "$REGION" \
  --allow-unauthenticated --port 8080 \
  --min-instances 0 --max-instances 2 --memory 1Gi --cpu 1 --concurrency 20 --timeout 120 \
  --cpu-boost \
  --set-env-vars "LLM_PROVIDER=gemini,STT_PROVIDER=gemini,STT_NO_LOCAL=1,TTS_PROVIDER=$TTS,GEMINI_MODEL=$GEMINI_MODEL,GEMINI_STT_MODEL=$GEMINI_MODEL,LLM_RATE_PER_MIN=12" \
  --set-secrets "$SECRETS"

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')
echo "Deployed: $URL"
curl -s -o /dev/null -w "GET / -> %{http_code}\n" "$URL/"
curl -s "$URL/api/llm/status"; echo
