import { defineConfig } from "prisma/config";

// The datasource URL is read straight from `process.env.DATABASE_URL`.
//
// We intentionally do NOT `import "dotenv/config"` here: `dotenv` is not a
// dependency of this project and is absent from the production image built
// with `npm ci --omit=dev`. Requiring it caused `prisma migrate deploy` in the
// Kubernetes `migrate` init container to crash on startup. In every deployed
// environment DATABASE_URL is injected as a real process env var (K8s
// ConfigMap/Secret), so reading it directly is sufficient. For local
// development, export DATABASE_URL in your shell or use `dotenv-cli`.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
