MAKEFLAGS += --warn-undefined-variables
SHELL := /bin/bash

NETWORK ?= localhost
PORT ?= 8080
SIM_ARGS ?=

.PHONY: help node simulate serve

help:
	@echo "Targets disponiveis:"
	@echo "  make node      # inicia o hardhat node (mantenha este terminal aberto)"
	@echo "  make simulate  # executa o scripts/simulate.js usando a rede $(NETWORK)"
	@echo "  make serve     # publica frontend/index.html em http://localhost:$(PORT)"
	@echo ""
	@echo "Dica: execute cada alvo em um terminal separado."

node:
	@echo "Iniciando Hardhat node..."
	npx hardhat node

simulate:
	@echo "Executando simulacoes na rede $(NETWORK)..."
	HARDHAT_NETWORK=$(NETWORK) npx hardhat run scripts/simulate.js --network $(NETWORK) $(SIM_ARGS)

serve:
	@echo "Servindo frontend/ em http://localhost:$(PORT)"
	cd frontend && python3 -m http.server $(PORT)
