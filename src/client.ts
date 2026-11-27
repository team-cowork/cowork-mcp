import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

type Scope = "workspace:read" | "chat:read" | "chat:write";
type AccessToken = { value: string; refreshAt: number };

const exchangePath = "/api/authorization/auth/agent-tokens/exchange";
const exchangeResult = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});
const maxRetries = 2;
const maxWaitMs = 30_000;

export class CoworkError extends Error {}

function retryDelay(response: Response, fallback: number, now: number): number {
  const header = response.headers.get("retry-after");
  if (!header) return fallback;
  if (/^\d+$/.test(header)) return Number(header) * 1_000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? fallback : Math.max(0, date - now);
}

export class CoworkClient {
  private token?: AccessToken;
  private exchangeInFlight?: Promise<AccessToken>;

  constructor(
    private readonly baseUrl: URL,
    private readonly agentToken: string,
    private readonly fetchRequest = fetch,
    private readonly wait: (ms: number) => Promise<unknown> = sleep,
    private readonly now = Date.now,
  ) {}

  private async send(path: string, init: RequestInit): Promise<Response> {
    return this.fetchRequest(new URL(path, this.baseUrl), {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  }

  private async release(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
  }

  private async exchange(): Promise<AccessToken> {
    for (let attempt = 0; ; attempt++) {
      const startedAt = this.now();
      const response = await this.send(exchangePath, {
        method: "POST",
        headers: { "X-Cowork-Agent-Token": this.agentToken },
      }).catch(() => {
        throw new CoworkError("Could not reach cowork to exchange the agent token.");
      });
      if (response.ok) {
        const payload = z.object({ data: exchangeResult }).safeParse(await readJson(response));
        if (!payload.success) throw new CoworkError("Invalid cowork token exchange response.");
        const lifetime = payload.data.data.expires_in * 1_000;
        return {
          value: payload.data.data.access_token,
          refreshAt: startedAt + lifetime - Math.min(30_000, lifetime / 10),
        };
      }
      await this.release(response);
      if (response.status === 401) {
        throw new CoworkError("The cowork agent token is invalid, expired or revoked.");
      }
      if (response.status !== 429) {
        throw new CoworkError(`Cowork token exchange failed (HTTP ${response.status}).`);
      }
      await this.waitForRateLimit(response, attempt, 6_000);
    }
  }

  private async waitForRateLimit(response: Response, attempt: number, fallback: number) {
    const delay = retryDelay(response, fallback, this.now());
    if (attempt >= maxRetries || delay > maxWaitMs) {
      throw new CoworkError(`Cowork rate limit reached (HTTP 429). Retry after ${Math.ceil(delay / 1_000)}s.`);
    }
    await this.wait(delay);
  }

  private getToken(): Promise<AccessToken> {
    if (this.token && this.token.refreshAt > this.now()) return Promise.resolve(this.token);
    this.exchangeInFlight ??= this.exchange()
      .then((token) => (this.token = token))
      .finally(() => { this.exchangeInFlight = undefined; });
    return this.exchangeInFlight;
  }

  async request(path: string, scope: Scope, body?: object): Promise<unknown> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let refreshed = false;
    let retries = 0;

    for (;;) {
      const token = await this.getToken();
      const headers = new Headers({ Authorization: `Bearer ${token.value}` });
      if (payload !== undefined) headers.set("Content-Type", "application/json");

      let response: Response;
      try {
        response = await this.send(path, {
          method: payload === undefined ? "GET" : "POST",
          headers,
          body: payload,
        });
      } catch {
        if (retries >= maxRetries) throw new CoworkError("Could not reach cowork. Request outcome is unknown.");
        await this.wait(500 * 2 ** retries++);
        continue;
      }
      if (response.ok) return readJson(response);
      await this.release(response);

      if (response.status === 401) {
        if (this.token === token) this.token = undefined;
        if (refreshed) throw new CoworkError("Cowork rejected the refreshed access token (HTTP 401).");
        refreshed = true;
        continue;
      }
      if (response.status === 403) {
        throw new CoworkError(`Cowork denied this request (HTTP 403). Required scope: ${scope}. Check the token scope and your cowork permissions.`);
      }
      if (response.status === 429) {
        await this.waitForRateLimit(response, retries++, 6_000);
        continue;
      }
      if ([500, 502, 503, 504].includes(response.status) && retries < maxRetries) {
        await this.wait(500 * 2 ** retries++);
        continue;
      }
      throw new CoworkError(`Cowork request failed (HTTP ${response.status}).`);
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CoworkError("Cowork returned an unreadable response.");
  }
}
