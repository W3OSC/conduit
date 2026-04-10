.PHONY: help dev build start stop migrate docker-up docker-down test lint clean install

# ── Conduit Makefile ──────────────────────────────────────────────────────────

help:
	@echo ""
	@echo "  Conduit — Personal messaging hub with AI agent API"
	@echo ""
	@echo "  Development:"
	@echo "    make dev          Start all services (server + client)"
	@echo "    make server       Start Node.js server only"
	@echo "    make client       Start React client only"
	@echo ""
	@echo "  Build & Deploy:"
	@echo "    make build        Build all packages"
	@echo "    make migrate      Run database migrations"
	@echo "    make docker-up    Build and start Docker containers"
	@echo "    make docker-down  Stop Docker containers"
	@echo ""
	@echo "  Other:"
	@echo "    make install      Install npm dependencies"
	@echo "    make test         Run tests"
	@echo "    make lint         Run linters"
	@echo "    make clean        Clean build artifacts"
	@echo ""

install:
	npm install

dev:
	npm run dev

server:
	npm run dev --workspace=packages/server

client:
	npm run dev --workspace=packages/client

build:
	npm run build

migrate:
	npm run migrate

docker-up:
	docker-compose up --build

docker-down:
	docker-compose down

test:
	npm run test --workspace=packages/server

lint:
	npm run lint --workspace=packages/server
	npm run lint --workspace=packages/client

clean:
	rm -rf packages/server/dist packages/client/dist
