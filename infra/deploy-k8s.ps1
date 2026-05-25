# Builds the service images, loads them into a self-hosted Kubernetes cluster,
# and applies the manifests in infra/k8s/.
#
# Usage:
#   ./infra/deploy-k8s.ps1                       # auto-detect the cluster type
#   ./infra/deploy-k8s.ps1 -ClusterType k3s      # force a cluster type
#   ./infra/deploy-k8s.ps1 -GeminiApiKey <key>   # also create the secret
#
# Prerequisites: docker and kubectl on PATH, and a reachable cluster.

param(
  [ValidateSet('auto', 'kind', 'minikube', 'k3s', 'none')]
  [string]$ClusterType = 'auto',
  [string]$Tag = 'latest',
  [string]$GeminiApiKey = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$ingestionImage = "llm-obs/ingestion:$Tag"
$chatbotImage = "llm-obs/chatbot:$Tag"

Write-Host "==> Building images" -ForegroundColor Cyan
docker build -f Dockerfile.ingestion -t $ingestionImage .
docker build -f Dockerfile.chatbot   -t $chatbotImage .

# Detect how to make the local images visible to the cluster.
if ($ClusterType -eq 'auto') {
  $ctx = ''
  try { $ctx = (kubectl config current-context) } catch {}
  if ($ctx -match 'kind') { $ClusterType = 'kind' }
  elseif ($ctx -match 'minikube') { $ClusterType = 'minikube' }
  elseif (Get-Command k3s -ErrorAction SilentlyContinue) { $ClusterType = 'k3s' }
  else { $ClusterType = 'none' }
  Write-Host "    detected cluster type: $ClusterType"
}

Write-Host "==> Loading images into the cluster ($ClusterType)" -ForegroundColor Cyan
switch ($ClusterType) {
  'kind' {
    kind load docker-image $ingestionImage
    kind load docker-image $chatbotImage
  }
  'minikube' {
    minikube image load $ingestionImage
    minikube image load $chatbotImage
  }
  'k3s' {
    docker save $ingestionImage | k3s ctr images import -
    docker save $chatbotImage   | k3s ctr images import -
  }
  'none' {
    Write-Host "    skipping load - assuming the cluster can already pull these images"
  }
}

Write-Host "==> Applying manifests" -ForegroundColor Cyan
kubectl apply -f infra/k8s/

# 01-config.yaml ships obs-secrets with GEMINI_API_KEY=''; override here so
# the chatbot can actually reach Gemini. -GeminiApiKey is required for a
# usable deployment.
if (-not $GeminiApiKey) {
  Write-Warning "No -GeminiApiKey provided. The chatbot will start, but Gemini calls will fail until you set the key (`kubectl -n llm-obs edit secret obs-secrets`)."
} else {
  Write-Host "==> Injecting obs-secrets with real Gemini key" -ForegroundColor Cyan
  kubectl -n llm-obs create secret generic obs-secrets `
    --from-literal=GEMINI_API_KEY=$GeminiApiKey `
    --from-literal=INGESTION_API_KEY=dev-ingest-key `
    --from-literal=DATABASE_URL=postgres://obs:obs@postgres:5432/observability `
    --from-literal=POSTGRES_PASSWORD=obs `
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n llm-obs rollout restart deploy/ingestion deploy/chatbot
}

Write-Host "==> Waiting for rollouts" -ForegroundColor Cyan
foreach ($d in 'postgres', 'redis', 'ingestion', 'chatbot') {
  kubectl -n llm-obs rollout status "deploy/$d" --timeout=180s
}

Write-Host "==> Done. Current pods:" -ForegroundColor Green
kubectl -n llm-obs get pods
Write-Host ""
Write-Host "Open the UI with:  kubectl -n llm-obs port-forward svc/chatbot 3000:80"
