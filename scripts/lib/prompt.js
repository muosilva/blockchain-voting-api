/**
 * Prompt builders and constants for LM Studio-based simulation generation.
 */

export const SYSTEM_PROMPT =
  "Voce cria configuracoes JSON de simulacoes para um contrato commit-reveal de votacao. Responda exclusivamente com JSON valido.";

const BASE_USER_PROMPT = `Regras gerais:
- Responda somente com JSON (sem markdown).
- Utilize o esquema {"defaults": {...}, "simulations": [...]} e mantenha a estrutura completa.
- O campo "defaults" e obrigatorio: SEMPRE inclua-o com as chaves listadas abaixo.
- Se um valor nao for solicitado, mantenha o valor sugerido.
- Cada simulacao precisa de id unico, name, options (array de strings) e votes (array de objetos com optionIndex ou option + label).
- Cada "name" deve agir como um titulo curto explicando claramente o objetivo/nuance do teste de integracao.
- Limite cada simulacao a no maximo 10 votos e garanta pelo menos 2 votos.
- Opcionalmente acrescente issuerIndex, timing, voterOffset ou output.file apenas quando fizer sentido.
- Varie os cenarios: altere temas (garagem, reformas, orcamento, obras emergenciais, sustentabilidade, etc.), tamanho do eleitorado (2 a 10 votantes), quantidade de opcoes (entre 2 e 8) e ajuste os defaults quando fizer sentido. Evite repetir nomes ou combinacoes de votos.
- Distribua as simulacoes para cobrir o maior numero possivel das situacoes abaixo (se o total de simulacoes for menor que a lista, priorize na ordem apresentada):
  1. SimpleVoting com maioria clara.
  2. SimpleVoting com empate ao final.
  3. SimpleVoting com tres ou mais opcoes e quoruns distintos.
  4. SimpleVoting com janela de tempo customizada (timing nao padrao).
  5. TokenizedVoting com useForVoting e mintsPerVoter permitindo commits multiplos do mesmo eleitor.
  6. TokenizedVoting definindo token.mintTo explicito para distribuir NFTs antes do commit.
  7. TokenizedVoting com token.transfers simulando negociacao de NFTs antes do commit.
  8. Cenarios que alternem issuerIndex e voterOffset para exercitar diferentes contas.
- Quando produzir TokenizedVoting, sempre inclua "contractName": "TokenizedVoting" e descreva um bloco "token" coerente (pode combinar mintTo, useForVoting, mintsPerVoter, transfers).
- Para token.mintTo e token.transfers, referencie enderecos reais (ou os mesmos rotulos usados nos votos, como "Eleitor 1") e nunca use o placeholder "0x..." nem reticencias.

Defaults sugeridos (copie e ajuste apenas quando necessario):
{
  "issuerIndex": 0,
  "voterOffset": 1,
  "resetStateBetweenSimulations": true,
  "timing": {
    "startDelay": 5,
    "commitDuration": 60,
    "revealDuration": 60
  }
}`;

/**
 * Builds the user prompt for a given number of simulations.
 * Optionally includes a prior example payload to guide the model.
 */
export function buildUserPrompt({ count, example }) {
  const header = `Gere ${count === 1 ? "uma" : `${count}`} simulacoes para um contrato de votacao condominial commit-reveal.`;
  const countRule = `- Entregue exatamente ${count} simulacoes; nao acrescente nem remova itens.`;
  const rules = `${countRule}\n${BASE_USER_PROMPT}`;
  if (example) {
    return `${header}\n\n${rules}\n\nExemplo existente:\n${example}`;
  }
  return `${header}\n\n${rules}`;
}
