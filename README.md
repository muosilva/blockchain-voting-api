# Blockchain Voting API

Sistema de votação totalmente on-chain construído em Solidity com Hardhat. A arquitetura combina privacidade (via commit-reveal) com um token de stake (ERC-721) transferível que define quem pode votar em cada pauta.

- **Commit-Reveal**: primeiro o eleitor registra um compromisso criptográfico; na janela de revelação ele abre o voto junto com o segredo (salt) que prova a autoria. Nenhum voto pode ser lido antes do prazo e cópias são descartadas.
- **Blind Signatures**: a autoridade emite credenciais assinadas sem enxergar o conteúdo final. Assim apenas eleitores autorizados participam, mas a identidade permanece desvinculada da transação on-chain.
- **Token de Stake (ERC-721)**: um contrato independente (`StakeToken.sol`) cunha NFTs que representam o poder de voto. O contrato de pauta (`TokenizedVoting.sol`) apenas referencia esse token externo. Quem detém o NFT pode chamar `commitVoteWithToken`; transferir o token antes do commit move o direito de voto para outro usuário.

## Visão Geral do Fluxo

1. **Preparação (off-chain)**
   - A autoridade embaralha/gera credenciais cegas para cada eleitor e assina cada hash.
   - O eleitor guarda o par (credentialHash, signature) e um salt secreto.

2. **Distribuição do token de stake (on-chain)**
   - O administrador chama `mint` ou `batchMint` em `StakeToken.sol` e entrega um NFT PoS para cada participante elegível.
   - Os tokens podem ser transferidos livremente até o commit; o novo dono assume o direito de votar naquela pauta.

3. **Commit (on-chain)**
   - Entre `startAt` e `commitEndAt`, o eleitor calcula `commitment = keccak256(credentialHash, optionIndex, salt, committer)` onde `committer` é o endereço do próprio remetente (`msg.sender`).
   - Ele chama `commitVoteWithToken(tokenId, credentialHash, commitment, signature)` a partir da carteira do dono do token.
   - O contrato verifica a assinatura da autoridade, confere que o chamador é o dono do token (sem operadores/aprovados), vincula o compromisso ao remetente e armazena apenas o hash do voto.

4. **Reveal (on-chain)**
   - Entre `commitEndAt` e `endAt`, o eleitor chama `revealVote(credentialHash, optionIndex, salt)`.
   - O contrato recomputa o compromisso incluindo o endereço do remetente que efetuou o commit e valida antes de contar o voto.

5. **Finalização**
   - Após `endAt`, qualquer conta pode chamar `finalize()` para emitir o evento `Finalized` com o resultado.

Metáfora: a secretaria distribui fichas carimbadas de participação (token de stake PoS). O eleitor escreve o voto em um papel cifrado e lacra no envelope (commit). Na hora certa, mostra o papel e o carimbo para validar e contar (reveal). Se vender ou repassar a ficha antes do commit, transfere junto o direito de votar.

## Estrutura do Projeto

```
contracts/
  SimpleVoting.sol       # Núcleo commit-reveal + credenciais blindadas
  StakeToken.sol         # Token ERC-721 de stake PoS distribuído pelo emissor
  TokenizedVoting.sol    # Referência ao StakeToken externo para autorizar commits
scripts/
  deploy.js              # Deploy do StakeToken + TokenizedVoting em uma rede Hardhat configurada
  simulate.js            # Simulação completa (mint stake + commit + reveal) e exporta dados para o frontend
frontend/
  index.html             # Visualizador simples que lê cache/simulate-result.json
cache/
  simulate-result.json   # Gerado pelo script de simulação para fins de demonstração
```

## Pré-requisitos

- Node.js >= 18
- npm (incluso no Node)
- Hardhat (listado em `devDependencies`)

Instale as dependências:

```bash
npm install
```

## Como Rodar

### 1. Subir uma rede local

```bash
npm run node
```

Mantém uma Hardhat Network com contas pré-carregadas.

### 2. Rodar a simulação end-to-end

Em outro terminal:

```bash
npm run simulate
```

O script:

- faz deploy do `StakeToken` e do `TokenizedVoting` com janelas relativas ao horário atual;
- usa a primeira conta como autoridade emissora (issuer) e proprietária do contrato;
  - cunha um token de stake (`StakeToken.mint`) para cada um dos cinco eleitores fictícios;
- cada eleitor gera salt/certificado aleatório, envia `commitVoteWithToken`, avança o tempo e executa o `reveal`;
- grava `cache/simulate-result.json` com metadados da pauta, opções, hashes de transação, tokenId utilizado, timestamps de commit/reveal e segredos.

### 3. Visualizar no frontend demo

Sirva o diretório do projeto com um servidor estático (exemplo):

```bash
npx http-server .
```

Acesse `http://localhost:8080/frontend/index.html`. A página carrega o JSON da simulação e exibe:

- título da pauta, fases e timestamps;
- endereço do emissor e do contrato;
- painel de progresso das pautas em aberto com timestamp, token de stake, carteira e hashes dos votos;
- lista de votos com `tokenId`, commitment e credencial (hashes);
- status de cada pauta (janela de commit/reveal e vencedor).

> Rode `npm run simulate` sempre que quiser gerar dados atualizados.

### 4. Coleta de métricas automatizadas

O runner grava, no mesmo JSON salvo em `cache/`, dois blocos novos:

- `telemetry.transactions`: cada transação do experimento com tipo (`deploy-voting`, `vote-commit`, etc.), conta envolvida, gas usado, custo estimado em ETH, timestamp do bloco e duração em milissegundos.
- `metrics`: agregados prontos para o TCC separados em `performance`, `security` e `usability`. Exemplos:
  - `performance.gas.commit` resume gas/custos dos commits, enquanto `performance.timing` mostra a diferença entre as janelas configuradas e os horários observados.
  - `security.credentialIntegrity`, `security.windowEnforcement` e `security.auditTrail` indicam duplicidades, violações de janela e se o snapshot foi registrado.
  - `usability.transactionsPerVoter`, `usability.avgVoteFeeEth` e `usability.tokenProvisioning` medem o esforço e o custo médio por eleitor, além da preparação do stake.

Rode `npm run simulate` (ou `npx hardhat run scripts/simulate.js --network ...`) para atualizar esses blocos. Exemplos rápidos via CLI:

```bash
jq '.metrics.performance.throughput' cache/simulate-*.json
jq '.telemetry.transactions[] | select(.type == "vote-commit") | {label, gasUsed, feeEth}' cache/simulate-*.json
```

Assim você consegue registrar evidências numéricas de desempenho, segurança e usabilidade em cada experimento.

## Geração de simulações via LM Studio

Com o LM Studio rodando localmente (endpoint padrão `http://127.0.0.1:1234/v1/chat/completions`), você pode pedir à LLM que crie cenários prontos para o `scripts/simulate.js`.

- Arquivo exemplo (guia para a LLM): `scripts/simulations.example.json`
- Arquivo gerado (saída): `scripts/simulations.generated.json`

O script `scripts/generate-simulations-llm.js` usa, por padrão, o exemplo acima para orientar a LLM e grava a saída no arquivo gerado:

```bash
node scripts/generate-simulations-llm.js --model "nome-do-modelo-no-lm-studio"
```

Opções úteis:
- `--count` (`-c`): quantidade de simulações desejadas (ex.: `--count 10`).
- `--temperature`: ajusta a criatividade da resposta da LLM (padrão `0.4`).
- `--endpoint`: URL do servidor caso não esteja em `127.0.0.1:1234`.
- `--model`: nome do modelo carregado no LM Studio.
- `--out` (`-o`): caminho do arquivo de saída (padrão `scripts/simulations.generated.json`).
- `--example`: caminho de um JSON exemplo para guiar a LLM (padrão `scripts/simulations.example.json`).
- `--timeout`: timeout da requisição em ms (padrão `45000`).
- `--help`: mostra todas as flags disponíveis.

Exemplo para gerar 20 simulações variadas de assembleias condominiais:

```bash
node scripts/generate-simulations-llm.js --model "nome-do-modelo-no-lm-studio" --count 20
```

Depois da geração, você pode rodar o simulador diretamente (ele já usa o arquivo gerado por padrão):

```bash
npx hardhat run scripts/simulate.js --network localhost
```

Se desejar apontar para outro arquivo, use `--config`:

```bash
npx hardhat run scripts/simulate.js --network localhost --config caminho/para/arquivo.json
```

Para executar diretamente contra a Binance Smart Chain testnet utilize `--network binanceTestnet` (ou o script `npm run simulate:testnet`). Lembre-se de definir `SIMULATION_PRIVATE_KEYS` com todas as carteiras que farão commit/reveal para que o runner consiga assinar as transações. Você também pode apontar o script para contratos já existentes usando `--contract 0x...` e `--stake 0x...` quando quiser registrar commits em endereços previamente implantados.

Assim você pode validar os cenários sugeridos pela LLM e alimentar a interface ou outros testes automatizados.

## Deploy manual (opcional)

```bash
npm run deploy:local
```

O script realiza o deploy de `StakeToken` + `TokenizedVoting` na rede `localhost`. Ajuste datas ou a distribuição dos tokens de stake conforme sua necessidade.

## Detalhes dos Contratos

### SimpleVoting.sol

- `commitVote(bytes32 credentialHash, bytes32 commitment, bytes signature)`  
  Valida a assinatura da autoridade, verifica janelas e registra o compromisso. Na implementação base o peso de cada voto é 1.
- `revealVote(bytes32 credentialHash, uint8 optionIndex, bytes32 salt)`  
  Recalcula o hash, confere e incrementa o contador da opção escolhida.
- `revokeCredential` / `restoreCredential`  
  Permite invalidar credenciais não utilizadas caso o emissor detecte abuso.
- `metadata()`, `optionDetails()`, `ballotOf()`  
  Funções auxiliares para auditoria e integrações off-chain.

### StakeToken.sol

- `mint(address to)` e `batchMint(address[] to)`  
  Distribuem o token de stake PoS (NFT) para cada eleitor autorizado.
- `tokensOfOwner(address)`  
  Lista rápida dos tokenIds vinculados a um endereço — útil no frontend para exibir a carteira.
- `setBaseTokenURI(string)`  
  Ajusta o prefixo de metadados associado aos NFTs de stake.

### TokenizedVoting.sol

- `stakeTokenAddress()`  
  Retorna o endereço do contrato `StakeToken` utilizado como requisito de participação.
- `commitVoteWithToken(uint256 tokenId, bytes32 credentialHash, bytes32 commitment, bytes signature)`  
  Combina a verificação do token ERC-721 externo (dono ou operador aprovado) com a lógica de credencial cega do `SimpleVoting`.
- `tokenUsed(uint256 tokenId)`  
  Indica se o token de stake já teve commit registrado (evita reuso na mesma pauta).

## Perguntas Frequentes

**Por que manter blind signatures se o direito de voto já depende do token de stake?**  
Porque o NFT apenas autoriza quem pode votar; o commit-reveal continua garantindo sigilo do voto. A credencial cega impede que o administrador relacione token (ou endereço) ao conteúdo do voto revelado.

**Posso transferir o token de stake depois do commit?**  
Sim, mas o token marcado como usado não permite novo commit naquela pauta. Transferências antes do commit movem o direito de voto; depois do commit servem apenas como registro histórico.

**Como adapto para produção?**  
Substitua a simulação por processos reais: distribuição segura dos tokens de stake, geração de credenciais off-chain, clientes que saibam montar commitment/reveal nos prazos corretos e, se necessário, camadas extras de auditoria (ex.: provas de inclusão/exclusão, integrações com sistemas externos).

