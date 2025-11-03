/** JSON helpers for extracting valid payloads from LLM responses. */

/**
 * Extracts a JSON object from an OpenAI-compatible chat completion response body.
 * Accepts fenced code blocks (```json ... ```) or raw JSON text.
 * Throws on invalid/missing content.
 *
 * @param {string} responseText Raw HTTP response body as string
 * @returns {any} Parsed JSON object
 */
export function extractJson(responseText) {
  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`Resposta invalida do servidor: ${error.message}`);
  }
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Resposta nao contem conteudo utilizavel.");
  }
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const payload = fenced ? fenced[1].trim() : trimmed;
  const first = payload.indexOf("{");
  const last = payload.lastIndexOf("}");
  if (first === -1 || last === -1) {
    throw new Error("Nao foi encontrado JSON valido na resposta.");
  }
  const slice = payload.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch (error) {
    throw new Error(`Falha ao analisar JSON: ${error.message}`);
  }
}

