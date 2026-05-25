# Kubernetes deployment (self-hosted)

Manifests for running the stack on a self-hosted cluster (k3s, kubeadm, etc.).

## Build & load images

The cluster pulls local images (`imagePullPolicy: IfNotPresent`), so build
them where the cluster can see them:

```bash
# from the repo root
docker build -f Dockerfile.ingestion -t llm-obs/ingestion:latest .
docker build -f Dockerfile.chatbot   -t llm-obs/chatbot:latest .

# k3s: import images into the containerd runtime
docker save llm-obs/ingestion:latest | sudo k3s ctr images import -
docker save llm-obs/chatbot:latest   | sudo k3s ctr images import -
```

## Configure secrets

Edit `01-config.yaml` and set `GEMINI_API_KEY` and `INGESTION_API_KEY`, or:

```bash
kubectl -n llm-obs create secret generic obs-secrets \
  --from-literal=GEMINI_API_KEY=your-key \
  --from-literal=INGESTION_API_KEY=$(openssl rand -hex 16) \
  --from-literal=DATABASE_URL=postgres://obs:obs@postgres:5432/observability \
  --from-literal=POSTGRES_PASSWORD=obs
```

## Apply

```bash
kubectl apply -f infra/k8s/        # files are numbered for ordering
kubectl -n llm-obs get pods -w
```

The ingestion service auto-migrates the database on startup, so no migration
job is required.

## Access

Add `chat.local` to your hosts file pointing at the ingress IP, then open
<http://chat.local>. Without an ingress controller:

```bash
kubectl -n llm-obs port-forward svc/chatbot 3000:80
```

## Notes

- `ingestion` runs 2 replicas with an HPA (2-8 pods, 70% CPU target). It is
  stateless - the Redis-backed BullMQ queue lets replicas share the workload.
- `postgres` uses a single replica + PVC. For production use a managed
  Postgres or an operator (CloudNativePG, Zalando) for HA and backups.
- The ingress disables proxy buffering so SSE streaming reaches the browser.
