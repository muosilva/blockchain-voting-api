# Blockchain Voting API

Sistema de votacao totalmente on-chain construido em Solidity com Hardhat. A arquitetura combina privacidade (via commit-reveal e blind signatures) com bilhetes ERC-721 transferiveis que controlam quem pode votar em cada pauta.

- **Commit-Reveal**: primeiro o eleitor registra um compromisso criptografico; em uma janela posterior ele revela o voto junto com o segredo (salt) que prova a autoria. Nenhum voto pode ser lido antes da hora e copias nao valem.
- **Blind Signatures**: a autoridade emite credenciais assinadas sem enxergar o conteudo final. Assim apenas eleitores autorizados participam, mas a identidade permanece separada da transacao on-chain.
- **Voting Tickets (ERC-721)**: para cada pauta o administrador cunha um NFT (`TokenizedVoting.sol`). O detentor atual do token e quem pode chamar `commitVoteWithToken`. Transferir o NFT antes do commit move o direito de voto para outro usuario, mantendo peso fixo igual a 1.

## Visao Geral do Fluxo

1. **Preparacao (off-chain)**
   - A autoridade embaralha/gera credenciais cegas para cada eleitor e assina cada hash.
   - O eleitor guarda o par (credentialHash, signature) e um salt secreto.

2. **Distribuicao de bilhetes (on-chain)**
   - O administrador chama `mintVoteToken` (ou `mintVoteTokens`) e entrega um NFT para cada participante.
   - Os bilhetes podem ser transferidos livremente ate o commit; o novo dono assume o direito de votar naquela pauta.

3. **Commit (on-chain)**
   - Entre `startAt` e `commitEndAt`, o eleitor calcula `commitment = keccak256(credentialHash, optionIndex, salt)`.
   - Ele chama `commitVoteWithToken(tokenId, credentialHash, commitment, signature)`.
   - O contrato verifica a assinatura da autoridade, confere que o chamador e dono (ou aprovado) do token e armazena somente o hash do voto.

4. **Reveal (on-chain)**
   - Entre `commitEndAt` e `endAt`, o eleitor chama `revealVote(credentialHash, optionIndex, salt)`.
   - O contrato recomputa o compromisso, valida e incrementa o contador da opcao escolhida.

5. **Finalizacao**
   - Após `endAt`, qualquer conta pode chamar `finalize()` para emitir o evento `Finalized` com o resultado.

Metafora: a secretaria distribui fichas carimbadas (NFTs). O eleitor escreve o voto em um papel cifrado e lacra no envelope (commit). Na hora certa, mostra seu papel e o carimbo para validar e contar (reveal). Se vender ou repassar a ficha antes do commit, transfere junto o direito de votar.

## Estrutura do Projeto

```
contracts/
  SimpleVoting.sol       # Nucleo commit-reveal + credenciais blindadas
  TokenizedVoting.sol    # Extensao ERC-721 que torna o voto transferivel (peso 1)
scripts/
  deploy.js              # Deploy manual do TokenizedVoting em uma rede Hardhat configurada
  simulate.js            # Simulacao completa (mint tickets + commit + reveal) e exporta dados para o frontend
frontend/
  index.html             # Visualizador simples que le cache/simulate-result.json
cache/
  simulate-result.json   # Gerado pelo script de simulacao para fins de demonstracao
```

## Pre-requisitos

- Node.js >= 18
- npm (incluso no Node)
- Hardhat (listado em `devDependencies`)

Instale dependencias:

```bash
npm install
```

## Como Rodar

### 1. Subir uma rede local

```bash
npm run node
```

Mantem um Hardhat Network com contas pre-carregadas.

### 2. Rodar a simulacao end-to-end

Em outro terminal:

```bash
npm run simulate
```

O script:

- faz deploy de `TokenizedVoting` com janelas relativas ao horario atual;
- usa a primeira conta como autoridade emissora (issuer) e proprietario do contrato;
- cunha um NFT (`mintVoteToken`) para cada um dos cinco eleitores ficticios;
- cada eleitor gera salt/certificado aleatorio, envia `commitVoteWithToken`, avanca o tempo e executa o `reveal`;
- grava `cache/simulate-result.json` com metadados da pauta, opcoes, hashes de transacao, tokenId utilizado e segredos.

### 3. Visualizar no frontend demo

Sirva o diretorio do projeto com um servidor estatico (exemplo):

```bash
npx http-server .
```

Acesse `http://localhost:8080/frontend/index.html`. A pagina carrega o JSON da simulacao e exibe:

- titulo da pauta, fases e timestamps;
- endereco do emissor e do contrato;
- lista de votos com `tokenId`, commitment e credencial (hashes);
- status de cada pauta (janela de commit/reveal e vencedor).

> Rode `npm run simulate` sempre que quiser gerar dados atualizados.

## Deploy manual (opcional)

```bash
npm run deploy:local
```

O script realiza o deploy de `TokenizedVoting` na rede `localhost`. Ajuste datas, URI base ou distribuicao de bilhetes conforme sua necessidade.

## Detalhes dos Contratos

### SimpleVoting.sol

- `commitVote(bytes32 credentialHash, bytes32 commitment, bytes signature)`  
  Valida a assinatura da autoridade, verifica janelas e registra o compromisso. Na implementacao base o peso de cada voto e 1.
- `revealVote(bytes32 credentialHash, uint8 optionIndex, bytes32 salt)`  
  Recalcula o hash, confere e incrementa o contador da opcao escolhida.
- `revokeCredential` / `restoreCredential`  
  Permite invalidar credenciais nao utilizadas caso o emissor detecte abuso.
- `metadata()`, `optionDetails()`, `ballotOf()`  
  Funcoes auxiliares para auditoria e integraches off-chain.

### TokenizedVoting.sol

- `mintVoteToken(address to)` e `mintVoteTokens(address[] to)`  
  Cunha NFTs transferiveis (peso 1) para cada eleitor autorizado.
- `commitVoteWithToken(uint256 tokenId, bytes32 credentialHash, bytes32 commitment, bytes signature)`  
  Combina a verificacao do token ERC-721 (dono ou operador aprovado) com a logica de credencial cega do `SimpleVoting`.
- `tokenUsed(uint256 tokenId)`  
  Indica se o bilhete ja teve commit registrado (evita reuso).
- `setBaseTokenURI(string)`  
  Atualiza o prefixo utilizado em metadados das NFTs.

## Perguntas Frequentes

**Por que manter blind signatures se o direito de voto ja depende de um NFT?**  
Porque o NFT apenas autoriza quem pode votar; o commit-reveal continua garantindo sigilo do voto. A credencial cega impede que o administrador relacione token (ou endereco) ao conteudo do voto revelado.

**Posso transferir o NFT depois do commit?**  
Sim, mas o bilhete marcado como usado nao permite novo commit. Transferencias antes do commit movem o direito de voto; depois do commit servem apenas como registro historico.

**Como adapto para producao?**  
Substitua a simulacao por processos reais: distribuicao segura dos NFTs, geracao de credenciais off-chain, clientes que saibam montar commitment/reveal nos prazos corretos e, se necessario, camadas extras de auditoria (ex: provas de inclusao/exclusao, integraches com sistemas externos).
