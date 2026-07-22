# Kubernetes — WhatsApp API

Manifests for the NestJS API. Image is published to
`ghcr.io/draskenlabs/draskenlabs.communication.whatsapp.api` by the Docker
workflow.

## Prerequisites

- A namespace is created by `namespace.yaml` (`whatsapp-platform`).
- **Image pull secret** (GHCR is private):
  ```sh
  kubectl -n whatsapp-platform create secret docker-registry ghcr-secret \
    --docker-server=ghcr.io \
    --docker-username=<github-user> \
    --docker-password=<github-PAT-with-read:packages>
  ```
- **App secrets** — copy the template, fill it in, and apply (keep it out of git):
  ```sh
  cp secret.example.yaml secret.yaml   # then edit
  kubectl apply -f secret.yaml
  ```
- A reachable **Postgres** (`DATABASE_URL`) and **Redis** (`REDIS_URL`).

## Deploy

```sh
kubectl apply -k .
```

This applies the namespace, config, deployment (with a Prisma
`migrate deploy` init container), service, ingress and HPA.

## Notes

- Edit `ingress.yaml` host (`api.example.com`), `ingressClassName`, and TLS
  issuer for your cluster.
- Health probes hit `GET /`.
- The init container runs database migrations before the app serves traffic.
