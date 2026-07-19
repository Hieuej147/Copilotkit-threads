SHELL := /usr/bin/env bash

CLUSTER ?= thread-platform
NAMESPACE ?= threads-local
RELEASE ?= starter
HTTP_PORT ?= 8080
HTTPS_PORT ?= 8443
CHART := infra/k8s/charts/thread-platform

.PHONY: demo-up demo-check demo-logs demo-db demo-down demo-reset dev-up dev-check dev-logs dev-down check-tools k3d-create images k3d-import helm-deps local-install local-up local-down local-status local-logs local-db helm-lint

demo-up:
	docker compose -f docker-compose.yml -f docker-compose.example.yml up -d --build --wait
	@$(MAKE) demo-check

demo-check:
	@docker compose -f docker-compose.yml -f docker-compose.example.yml ps
	@docker compose -f docker-compose.yml -f docker-compose.example.yml exec -T runtime wget -qO- http://localhost:4000/ready >/dev/null
	@docker compose -f docker-compose.yml -f docker-compose.example.yml exec -T runtime wget -qO- http://localhost:4000/api/copilotkit/info >/dev/null
	@docker compose -f docker-compose.yml -f docker-compose.example.yml exec -T web wget -qO- http://localhost:3000 >/dev/null
	@echo 'Demo ready on the configured WEB_PORT (default http://localhost:3000)'

demo-logs:
	docker compose -f docker-compose.yml -f docker-compose.example.yml logs --tail=200 -f

demo-db:
	docker compose -f docker-compose.yml -f docker-compose.example.yml exec postgres psql -U agent -d agent_threads

demo-down:
	docker compose -f docker-compose.yml -f docker-compose.example.yml down --remove-orphans

demo-reset:
	docker compose -f docker-compose.yml -f docker-compose.example.yml down --volumes --remove-orphans

dev-up:
	docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.example.yml up -d --build --wait
	@$(MAKE) dev-check

dev-check:
	@docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.example.yml ps
	@docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.example.yml exec -T runtime wget -qO- http://localhost:4000/ready >/dev/null
	@docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.example.yml exec -T web wget -qO- http://localhost:3000 >/dev/null
	@echo 'Development demo ready on the configured WEB_PORT (default http://localhost:3000)'

dev-logs:
	docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.example.yml logs --tail=200 -f

dev-down:
	docker compose -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.example.yml down --remove-orphans

check-tools:
	@command -v docker >/dev/null
	@command -v kubectl >/dev/null
	@command -v helm >/dev/null
	@command -v k3d >/dev/null

k3d-create: check-tools
	@k3d cluster get $(CLUSTER) >/dev/null 2>&1 || k3d cluster create $(CLUSTER) --agents 2 --port '$(HTTP_PORT):80@loadbalancer' --port '$(HTTPS_PORT):443@loadbalancer'

images:
	docker build -f apps/runtime/Dockerfile -t copilotkit-threads-runtime:local .
	docker build -f examples/langgraph-agent/Dockerfile -t copilotkit-threads-agent:local .
	docker build -f examples/nextjs-copilotkit/Dockerfile --build-arg NEXT_PUBLIC_RUNTIME_URL=/api/copilotkit --build-arg NEXT_PUBLIC_THREAD_API_URL= -t copilotkit-threads-web:local .

k3d-import: images k3d-create
	k3d image import -c $(CLUSTER) copilotkit-threads-runtime:local copilotkit-threads-agent:local copilotkit-threads-web:local

helm-deps: check-tools
	helm dependency update $(CHART)

local-install: k3d-import helm-deps
	kubectl create namespace $(NAMESPACE) --dry-run=client -o yaml | kubectl apply -f -
	@test -n "$$OPENAI_API_KEY" || (echo 'OPENAI_API_KEY is required' >&2; exit 1)
	kubectl -n $(NAMESPACE) create secret generic $(RELEASE)-model --from-literal=OPENAI_API_KEY="$$OPENAI_API_KEY" --from-literal=TITLE_API_KEY="$$OPENAI_API_KEY" --dry-run=client -o yaml | kubectl apply -f -
	helm upgrade --install $(RELEASE) $(CHART) -n $(NAMESPACE) -f $(CHART)/values-local.yaml --set runtime.image.repository=copilotkit-threads-runtime --set runtime.image.tag=local --set examples.agent.image.tag=local --set examples.web.image.tag=local --set examples.agent.existingSecret=$(RELEASE)-model --set titleWorker.existingSecret=$(RELEASE)-model --set-string 'runtime.corsOrigins[0]=http://threads.localhost:$(HTTP_PORT)' --wait --timeout 10m

local-up: local-install
	@echo 'Open http://threads.localhost:$(HTTP_PORT)'

local-down:
	k3d cluster delete $(CLUSTER)

local-status:
	kubectl -n $(NAMESPACE) get deploy,pod,job,cronjob,ingress

local-logs:
	kubectl -n $(NAMESPACE) logs -l app.kubernetes.io/instance=$(RELEASE) --all-containers --prefix --tail=200 -f

local-db:
	kubectl -n $(NAMESPACE) exec -it $(RELEASE)-postgresql-0 -- env PGPASSWORD=local-agent psql -U agent -d agent_threads

helm-lint: helm-deps
	helm lint $(CHART) -f $(CHART)/values-local.yaml
	helm template $(RELEASE) $(CHART) -n $(NAMESPACE) -f $(CHART)/values-local.yaml >/dev/null
