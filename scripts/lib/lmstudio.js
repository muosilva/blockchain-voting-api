/** Simple LM Studio client using global fetch (Node 18+). */

/**
 * Calls an OpenAI-compatible LM Studio chat completion endpoint.
 * Adds a request timeout via AbortController.
 *
 * @param {Object} params
 * @param {string} params.endpoint
 * @param {any} params.payload
 * @param {number} params.timeoutMs
 */
export async function callLmStudio({ endpoint, payload, timeoutMs = 45000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`LM Studio retornou status ${res.status}: ${text}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

