# Berto on Cloud Run: what to do at sign-in

Prepared 12 Oct 2026. Nothing has been deployed yet. gcloud SDK 588 and docker are installed on the box, and the image `berto:local` builds and passes a smoke test.

## Once, after `gcloud auth login`
```bash
gcloud auth login                         # opens a browser; sign in with the Google account that owns the billing
gcloud projects list                      # pick or create the project, e.g.:
# gcloud projects create caregenics-berto --name "CareGenicsAI Berto"
export PROJECT_ID=caregenics-berto
gcloud config set project $PROJECT_ID
gcloud billing accounts list              # note the ACCOUNT_ID
gcloud billing projects link $PROJECT_ID --billing-account ACCOUNT_ID

# 1) Enable the APIs
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com texttospeech.googleapis.com generativelanguage.googleapis.com billingbudgets.googleapis.com

# 2) Secret: create a NEW Gemini API key in AI Studio (https://aistudio.google.com/apikey) for this project.
#    Do not reuse any key that was ever pasted in chat. Paste it only into this prompt, never into a file:
read -rsp "Gemini API key: " K && printf %s "$K" | gcloud secrets create berto-gemini-api-key --data-file=- && unset K
PN=$(gcloud projects describe $PROJECT_ID --format 'value(projectNumber)')
gcloud secrets add-iam-policy-binding berto-gemini-api-key \
  --member "serviceAccount:$PN-compute@developer.gserviceaccount.com" --role roles/secretmanager.secretAccessor

# (optional) stable Web Push keys: node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"
# then create the secrets berto-vapid-public / berto-vapid-private the same way (and grant access).

# 3) Budget alert: PHP 500 per month, alerts at 50/90/100%. A budget only alerts; it does NOT cap spending.
gcloud billing budgets create --billing-account ACCOUNT_ID --display-name "Berto PHP500" \
  --budget-amount 500PHP --filter-projects projects/$PROJECT_ID \
  --threshold-rule percent=0.5 --threshold-rule percent=0.9 --threshold-rule percent=1.0
#   If the billing account is in USD, use --budget-amount 9USD (about PHP 500).
```

## Deploy (every time)
```bash
PROJECT_ID=caregenics-berto ops/deploy-cloudrun.sh
```
This builds with Cloud Build into Artifact Registry and deploys the `berto` service to asia-southeast1 with min 0 / max 2 instances, 1 vCPU, 1 GiB, concurrency 20 and public access. It sets LLM=Gemini 2.5 Flash, STT=Gemini audio, TTS=Google Cloud TTS (service account), and injects GEMINI_API_KEY from Secret Manager. At the end it prints the URL and checks `/` and `/api/llm/status` (`ready: true` means the key is wired).
To use edge-tts instead of Cloud TTS: `TTS_PROVIDER=edge PROJECT_ID=... ops/deploy-cloudrun.sh`.

## Known Cloud Run limits (fine for the Cup demo)
- Storage is per instance and temporary (`/tmp/berto`). Push subscriptions, reminder schedules and the Q/A log reset when an instance restarts. Patient logs live on the phone and are not affected. Production would need Firestore.
- With min-instances 0, the first request after idle takes a few seconds (cold start).
