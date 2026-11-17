/**
 * Dokploy API 的最小客户端。
 *
 * Dokploy 的接口是 tRPC 风格:`/api/<router>.<procedure>`,用 `x-api-key` 请求头鉴权。
 * 这里只提供通用的 query / mutate,不手写具体接口 —— 接口名和参数随版本变化,
 * 应当从你安装的那个 Dokploy 实例导出 OpenAPI 文档,再生成带类型的封装替换本文件。
 * 只有 publisher 使用,所以放在适配器目录里而不是独立成包。
 */
export interface DokployClientOptions {
  /** 例如 https://dokploy.corp.example */
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export class DokployError extends Error {
  constructor(
    readonly procedure: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Dokploy ${procedure} 返回 ${status}: ${body.slice(0, 500)}`);
    this.name = "DokployError";
  }
}

export class DokployClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DokployClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** 读接口(GET),参数放在查询串里 */
  async query<T>(procedure: string, input: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams(input).toString();
    const url = `${this.baseUrl}/api/${procedure}${qs ? `?${qs}` : ""}`;
    return this.send<T>(procedure, url, { method: "GET" });
  }

  /** 写接口(POST),参数放在 JSON 请求体里 */
  async mutate<T>(procedure: string, input: unknown = {}): Promise<T> {
    return this.send<T>(procedure, `${this.baseUrl}/api/${procedure}`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  private async send<T>(procedure: string, url: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: { "content-type": "application/json", "x-api-key": this.apiKey },
    });
    const text = await response.text();
    if (!response.ok) throw new DokployError(procedure, response.status, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
