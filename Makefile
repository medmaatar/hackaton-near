# Everything runs in Docker. The host needs Docker and nothing else.
.DEFAULT_GOAL := help

help: ## show targets
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

up: ## start agent + dashboard (mock settlement, no keys needed)
	docker compose up --build -d
	@echo "dashboard http://localhost:3000  agent http://localhost:8787/health"

down: ## stop everything
	docker compose down

logs: ## follow the agent log
	docker compose logs -f agent

test: ## run every contract rule test in the Rust image
	docker compose build contract-build
	docker compose run --rm --no-deps contract-build

wasm: ## build the contract and copy artifacts/mandate_otc.wasm
	docker compose run --rm --no-deps contract-build

demo: ## run the negotiation in the terminal
	docker compose run --rm --no-deps agent npm run demo

quote: ## day-1 Intents spike: real 1Click quote for 25 USDC
	docker compose run --rm --no-deps agent npm run quote

deploy: wasm ## deploy the contract to mainnet
	docker compose run --rm --no-deps agent npm run deploy

bootstrap: ## fund the vault and sign a mandate on mainnet
	docker compose run --rm --no-deps agent npm run bootstrap

typecheck: ## typecheck agent and dashboard inside their images
	docker compose run --rm --no-deps agent npm run typecheck
	docker compose run --rm --no-deps dashboard npm run build

clean: ## remove containers, images and the audit volume
	docker compose down -v --rmi local
