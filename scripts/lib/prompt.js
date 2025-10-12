/**
 * Prompt builders and constants for LM Studio-based simulation generation.
 */

export const SYSTEM_PROMPT =
  "Voce cria configuracoes JSON de simulacoes para um contrato commit-reveal de votacao. Responda exclusivamente com JSON valido.";

const BASE_USER_PROMPT = `Regras:
- Responda somente com JSON (sem markdown).
- Utilize o esquema {"defaults": {...}, "simulations": [...]} e mantenha a estrutura completa.
- O campo "defaults" e obrigatorio: SEMPRE inclua-o com as chaves listadas abaixo.
- Se um valor nao for solicitado, mantenha o valor sugerido.
- Cada simulacao precisa de id unico, name, options (array de strings) e votes (array de objetos com optionIndex ou option + label).
- Opcionalmente acrescente issuerIndex, timing ou output.file apenas quando fizer sentido.
- Varie os cenarios: altere temas (garagem, reformas, orcamento, obras emergenciais, sustentabilidade, etc.), tamanhos do eleitorado, quantidade de opcoes (entre 2 e 10) e ajuste os defaults quando fizer sentido. Evite repetir nomes ou combinacoes de votos.
- Garanta que as simulacoes reflitam as possibilidades diferentes de teste para cada cenário.

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

