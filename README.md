# Blockchain Voting API

Sistema de votação totalmente on-chain construído em Solidity com Hardhat, utilizando dois mecanismos clássicos de privacidade e auditabilidade:

- **Commit–Reveal**: primeiro você registra um compromisso criptográfico e associa ele ao seu voto; depois, em outra fase, revela o seu voto junto com o segredo que prova ser o dono daquela compromisso. Isso impede que alguém copie o voto antes da hora, como num concurso onde todos depositam envelopes em uma urna e só depois os abrem.
- **Blind Signatures**: cada eleitor recebe uma credencial assinada pela autoridade, porém essa assinatura é emitida sem que a autoridade enxergue o conteúdo final (analogia do "papel carbono": o escrivão assina o envelope opaco, e você transfere a assinatura para a ficha escondida lá dentro). Assim garantimos que apenas eleitores autorizados participem, sem revelar quem recebeu qual credencial.

O contrato `SimpleVoting.sol` combina esses dois mecanismos: apenas quem apresenta uma credencial válida consegue registrar o commit, e somente após a janela de commit é possível revelar e contabilizar o voto. Nenhuma parte do processo liga o voto diretamente a um endereço Ethereum; tudo gira em torno de um token opaco derivado da credencial.

## Visão Geral do Fluxo

1. **Preparação (off-chain)**
   - A autoridade emissora gera/sorteia credenciais cegas para cada eleitor e assina sem ver o conteúdo real.
   - O eleitor guarda a sua credencial (nonce + assinatura).

2. **Commit (on-chain)**
   - Dentro da janela `startAt → commitEndAt`, o eleitor calcula um compromisso `keccak256(credentialHash, optionIndex, salt)` e envia para `commitVote`, junto com a credencial e a assinatura da autoridade.
   - O contrato verifica a assinatura contra o endereço do emissor, garante que aquela credencial ainda não foi usada e guarda apenas o compromisso.

3. **Reveal (on-chain)**
   - Após `commitEndAt` e antes de `endAt`, o eleitor chama `revealVote(credentialHash, optionIndex, salt)`.
   - O contrato recomputa o compromisso com base no token da credencial e, se corresponder, credita um voto para a opção informada.

4. **Finalização**
   - Terminada a fase de reveal, qualquer conta pode chamar `finalize()` para emitir o evento `Finalized`, consolidando o resultado.

### Metáfora resumida

Imagine uma assembleia com envelopes lacrados e fichas carimbadas:

- A secretaria distribui fichas carimbadas (blind signature) a quem tem direito a voto, mas não sabe qual ficha cada pessoa pegou.
- Cada um escreve um código secreto na ficha, coloca num envelope e joga na urna antes de ela ser lacrada (commit).
- Quando a urna é aberta na hora certa, o eleitor mostra apenas o código secreto — não o nome — e o envelope correspondente é identificado e contado (reveal).

## Estrutura do Projeto

```
contracts/
  SimpleVoting.sol     # Contrato principal com commit-reveal + credenciais blindadas
scripts/
  deploy.js            # Deploy manual para uma rede configurada no Hardhat
  simulate.js          # Executa uma simulação completa (commit + reveal) e gera dados para o frontend
frontend/
  index.html           # Página simples que lê cache/simulate-result.json e exibe os resultados
cache/
  simulate-result.json # Gerado pela simulação; usado para o frontend demonstrar o processo
```

## Pré-requisitos

- Node.js ≥ 18
- npm (incluso no Node)
- Hardhat já está listado como dependência

Instale as dependências:

```bash
npm install
```

## Como Rodar

### 1. Iniciar uma rede local

```bash
npm run node
```

Este comando abre um nó Hardhat com contas predefinidas. Mantenha o processo rodando em um terminal.

### 2. Executar a simulação end-to-end

Em outro terminal:

```bash
npm run simulate
```

O script faz o seguinte:

- faz o deploy do contrato `SimpleVoting` com datas relativas ao tempo atual;
- usa a primeira conta do Hardhat como autoridade emissora que assina credenciais;
- seleciona cinco contas como eleitores, gera commits com salts aleatórios, envia os commits, avança o tempo e realiza os reveals;
- salva o arquivo `cache/simulate-result.json` com todos os hashes, transações e metadados.

Você verá no console logs para cada `commit` e `reveal`, além do resumo final da votação.

### 3. Visualizar no frontend de demonstração

Sirva o diretório do projeto (pode ser com qualquer servidor estático, por exemplo):

```bash
npx http-server .
```

Acesse `http://localhost:8080/frontend/index.html` (ajuste a porta/conjunto conforme o servidor escolhido). A página carrega `cache/simulate-result.json` e mostra:

- pauta e carimbo de geração;
- endereço da autoridade emissora;
- horários de término da fase de commit e reveal;
- para cada eleitor: hash do compromisso (`voteToken`), hash da credencial (`voterToken`), opção revelada e hashes das transações de commit/reveal.

> Importante: sempre rode `npm run simulate` depois de iniciar o nó local para gerar um arquivo de resultados atualizado.

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

Caso queira fazer o deploy manual em outra rede Hardhat configurada, use:

```bash
npm run deploy:local
```

Ajuste `scripts/deploy.js` ou as configurações de rede no `hardhat.config.js` conforme sua necessidade.

## Detalhes Técnicos do Contrato

- Guarda o dono (`owner`) e a autoridade (`issuer`) que assina as credenciais.
- `commitVote(bytes32 credentialHash, bytes32 commitment, bytes signature)`
  - valida fase e formato do token;
  - verifica a assinatura da autoridade sobre `credentialHash`;
  - armazena o compromisso associado ao token opaco.
- `revealVote(bytes32 credentialHash, uint8 optionIndex, bytes32 salt)`
  - aceita apenas na janela de reveal;
  - recomputa `keccak256(credentialHash, optionIndex, salt)` para conferir o compromisso;
  - incrementa o contador sem revelar nenhum endereço.
- `ballotOf(bytes32 credentialHash)` retorna o compromisso e se ele já foi revelado, auxiliando auditorias.

## Perguntas Frequentes

**Por que usar blind signatures se já existe o commit–reveal?**

> O commit–reveal impede que o voto seja lido antes da hora, mas, sozinho, ele ainda exige que o contrato saiba quem está autorizando o commit. As blind signatures permitem que a autoridade distribua credenciais sem amarrá-las publicamente a um eleitor específico, conciliando controle de acesso e privacidade.

**Onde ocorre a parte "cega" da assinatura?**

> Sempre fora da blockchain. O contrato só recebe a assinatura já descegada (o eleitor faz isso localmente) e valida com a chave pública da autoridade.

**Como adapto para produção?**

> Troque o script de simulação por fluxos reais: geração de credenciais off-chain, distribuição segura aos eleitores, interface web/mobile que prepare o commit e realize o reveal no tempo certo. Considere também adicionar mecanismos de registro extra e provas de inclusão/exclusão conforme o caso de uso.
