# Blockchain Voting API

Sistema de votacao totalmente on-chain construido em Solidity com Hardhat. A arquitetura combina privacidade (via commit-reveal e blind signatures) com um token de stake (ERC-721) transferivel que controla quem pode votar em cada pauta.

- **Commit-Reveal**: primeiro o eleitor registra um compromisso criptografico; em uma janela posterior ele revela o voto junto com o segredo (salt) que prova a autoria. Nenhum voto pode ser lido antes da hora e copias nao valem.
- **Blind Signatures**: a autoridade emite credenciais assinadas sem enxergar o conteudo final. Assim apenas eleitores autorizados participam, mas a identidade permanece separada da transacao on-chain.
- **Token de Stake (ERC-721)**: um contrato independente (`StakeToken.sol`) cunha NFTs que representam o poder de voto. O contrato de pauta (`TokenizedVoting.sol`) apenas referencia esse token externo. Quem detem o NFT pode chamar `commitVoteWithToken`; transferir o token antes do commit move o direito de voto para outro usuario.

## Visao Geral do Fluxo

1. **Preparacao (off-chain)**
   - A autoridade embaralha/gera credenciais cegas para cada eleitor e assina cada hash.
   - O eleitor guarda o par (credentialHash, signature) e um salt secreto.

2. **Distribuicao do token de stake (on-chain)**
   - O administrador chama `mint` ou `batchMint` em `StakeToken.sol` e entrega um NFT PoS para cada participante elegivel.
   - Os tokens podem ser transferidos livremente ate o commit; o novo dono assume o direito de votar naquela pauta.

3. **Commit (on-chain)**
   - Entre `startAt` e `commitEndAt`, o eleitor calcula `commitment = keccak256(credentialHash, optionIndex, salt, committer)` onde `committer` é o endereço do próprio remetente (`msg.sender`).
   - Ele chama `commitVoteWithToken(tokenId, credentialHash, commitment, signature)` a partir da carteira do dono do token.
   - O contrato verifica a assinatura da autoridade, confere que o chamador é o dono do token (sem operadores/aproved), vincula o compromisso ao remetente e armazena apenas o hash do voto.

4. **Reveal (on-chain)**
   - Entre `commitEndAt` e `endAt`, o eleitor chama `revealVote(credentialHash, optionIndex, salt)`.
   - O contrato recomputa o compromisso incluindo o endereço do remetente que efetuou o commit e valida antes de contar o voto.

5. **Finalizacao**
   - Após `endAt`, qualquer conta pode chamar `finalize()` para emitir o evento `Finalized` com o resultado.

Metafora: a secretaria distribui fichas carimbadas de participacao (token de stake PoS). O eleitor escreve o voto em um papel cifrado e lacra no envelope (commit). Na hora certa, mostra seu papel e o carimbo para validar e contar (reveal). Se vender ou repassar a ficha antes do commit, transfere junto o direito de votar.

## Estrutura do Projeto

```
contracts/
  SimpleVoting.sol       # Nucleo commit-reveal + credenciais blindadas
  StakeToken.sol         # Token ERC-721 de stake PoS distribuido pelo emissor
  TokenizedVoting.sol    # Referencia o StakeToken externo para autorizar commits
scripts/
  deploy.js              # Deploy do StakeToken + TokenizedVoting em uma rede Hardhat configurada
  simulate.js            # Simulacao completa (mint stake + commit + reveal) e exporta dados para o frontend
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

- faz deploy do `StakeToken` e do `TokenizedVoting` com janelas relativas ao horario atual;
- usa a primeira conta como autoridade emissora (issuer) e proprietario do contrato;
  - cunha um token de stake (`StakeToken.mint`) para cada um dos cinco eleitores ficticios;
- cada eleitor gera salt/certificado aleatorio, envia `commitVoteWithToken`, avanca o tempo e executa o `reveal`;
- grava `cache/simulate-result.json` com metadados da pauta, opcoes, hashes de transacao, tokenId utilizado, timestamps de commit/reveal e segredos.

### 3. Visualizar no frontend demo

Sirva o diretorio do projeto com um servidor estatico (exemplo):

```bash
npx http-server .
```

Acesse `http://localhost:8080/frontend/index.html`. A pagina carrega o JSON da simulacao e exibe:

- titulo da pauta, fases e timestamps;
- endereco do emissor e do contrato;
- painel de progresso das pautas em aberto com timestamp, token de stake, carteira e hashes dos votos;
- lista de votos com `tokenId`, commitment e credencial (hashes);
- status de cada pauta (janela de commit/reveal e vencedor).

> Rode `npm run simulate` sempre que quiser gerar dados atualizados.

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

Assim você pode validar os cenários sugeridos pela LLM e alimentar a interface ou outros testes automatizados.

## Deploy manual (opcional)

```bash
npm run deploy:local
```

O script realiza o deploy de `StakeToken` + `TokenizedVoting` na rede `localhost`. Ajuste datas ou a distribuicao dos tokens de stake conforme sua necessidade.

## Detalhes dos Contratos

### SimpleVoting.sol

- `commitVote(bytes32 credentialHash, bytes32 commitment, bytes signature)`  
  Valida a assinatura da autoridade, verifica janelas e registra o compromisso já atrelado ao endereço do remetente.
- `revealVote(bytes32 credentialHash, uint8 optionIndex, bytes32 salt)`  
  Recalcula o hash com `(credentialHash, optionIndex, salt, committer)` e incrementa o contador da opção escolhida.
- `revokeCredential` / `restoreCredential`  
  Permite invalidar credenciais nao utilizadas caso o emissor detecte abuso.
- `metadata()`, `optionDetails()`, `ballotOf()`  
  Funcoes auxiliares para auditoria e integraches off-chain.

### StakeToken.sol

- `mint(address to)` e `batchMint(address[] to)`  
  Distribuem o token de stake PoS (NFT) para cada eleitor autorizado.
- `tokensOfOwner(address)`  
  Lista rapida dos tokenIds vinculados a um endereco — util no frontend para exibir a carteira.
- `setBaseTokenURI(string)`  
  Ajusta o prefixo de metadados associado aos NFTs de stake.

### TokenizedVoting.sol

- `stakeTokenAddress()`  
  Retorna o endereco do contrato `StakeToken` utilizado como requisito de participacao.
- `commitVoteWithToken(uint256 tokenId, bytes32 credentialHash, bytes32 commitment, bytes signature)`  
  Apenas o dono do token pode realizar commit; operadores/aprovações não são aceitos. O método integra a autorização por token ao fluxo de credencial cega do `SimpleVoting`.
- `tokenUsed(uint256 tokenId)`  
  Indica se o token de stake ja teve commit registrado (evita reuso na mesma pauta).

## Perguntas Frequentes

**Por que manter blind signatures se o direito de voto ja depende do token de stake?**  
Porque o NFT apenas autoriza quem pode votar; o commit-reveal continua garantindo sigilo do voto. A credencial cega impede que o administrador relacione token (ou endereco) ao conteudo do voto revelado.

**Posso transferir o token de stake depois do commit?**  
Sim, mas o token marcado como usado nao permite novo commit naquela pauta. Transferencias antes do commit movem o direito de voto; depois do commit servem apenas como registro historico.

**Como adapto para producao?**  
Substitua a simulacao por processos reais: distribuicao segura dos tokens de stake, geracao de credenciais off-chain, clientes que saibam montar commitment/reveal nos prazos corretos e, se necessario, camadas extras de auditoria (ex: provas de inclusao/exclusao, integraches com sistemas externos).
