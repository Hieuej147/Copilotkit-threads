# Standalone Consumer Starter

This folder intentionally has no workspace dependency. Its web app installs the
released `@kiri_ikki/thread-react` package and Compose pulls the released Runtime
image. Copy this folder into a separate location to prove integration boundaries.

```bash
cp .env.example .env
# Set OPENAI_API_KEY
docker compose up --build -d
docker compose ps
docker compose logs -f runtime agent title-worker web
```

Open `http://localhost:3000`. Inspect storage with:

```bash
docker compose exec postgres psql -U agent -d agent_threads
```

Replace `agent/app/graph.py` with the product graph first. Keep the `/agent`
AG-UI endpoint and PostgreSQL checkpointer contract, then run the conformance
CLI from [Agent Contract](../../docs/AGENT_CONTRACT.md). Replace the demo web
with the product UI after the agent passes.

Stop with `docker compose down`; add `--volumes` only when local thread and
checkpoint history should be deleted.
