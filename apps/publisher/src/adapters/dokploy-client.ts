/**
 * Dokploy API 的最小客户端。
 *
 * Dokploy 的接口是 tRPC 风格:`/api/<模块>.<方法>`,用 `x-api-key` 请求头鉴权。
 * 只为用到的十几个接口在 dokploy.ts 里手写了返回类型,不从 OpenAPI 文档(600 多个接口)生成整套客户端。
 * 各接口的实测用法见 docs/dokploy-findings.md。
 */
export interface DokployClientOptions {
  /** 例如 https://dokploy.corp.example */
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** 接口报错时把响应内容记到服务端日志。默认输出到 console.error */
  logError?: (message: string) => void;
}

/**
 * 调用 Dokploy 接口失败。
 *
 * message 里只有接口名和状态码,不含响应内容:响应里可能有环境变量、数据库密码,
 * 而发布失败时 message 会经由发布单传给 agent。响应内容只记在服务端日志里。
 */
export class DokployError extends Error {
  constructor(
    readonly procedure: string,
    readonly status: number,
  ) {
    super(`调用部署平台接口 ${procedure} 失败(HTTP ${status})`);
    this.name = "DokployError";
  }
}

export class DokployClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logError: (message: string) => void;

  constructor(options: DokployClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.logError = options.logError ?? ((message) => console.error(message));
  }

  /**
   * 读接口(GET),参数放在查询串里。quiet:出错时只抛异常、不写错误日志,
   * 给调用方会自己处理(比如有意忽略)错误的读取用
   */
  async query<T>(procedure: string, input: Record<string, string | number> = {}, options: { quiet?: boolean } = {}): Promise<T> {
    const params = new URLSearchParams(Object.entries(input).map(([k, v]) => [k, String(v)]));
    const qs = params.toString();
    return this.send<T>(procedure, `${this.url(procedure)}${qs ? `?${qs}` : ""}`, { method: "GET" }, options.quiet);
  }

  /** 写接口(POST),参数放在 JSON 请求体里 */
  async mutate<T>(procedure: string, input: unknown = {}): Promise<T> {
    return this.send<T>(procedure, this.url(procedure), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  /** 表单上传(POST multipart)。不设 content-type,由 fetch 自动加上带分隔符的值 */
  async upload<T>(procedure: string, form: FormData): Promise<T> {
    return this.send<T>(procedure, this.url(procedure), { method: "POST", body: form });
  }

  private url(procedure: string): string {
    return `${this.baseUrl}/api/${procedure}`;
  }

  private async send<T>(procedure: string, url: string, init: RequestInit, quiet = false): Promise<T> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), "x-api-key": this.apiKey },
    });
    const text = await response.text();
    if (!response.ok) {
      if (!quiet) this.logError(`Dokploy ${procedure} 返回 ${response.status}: ${text.slice(0, 2000)}`);
      throw new DokployError(procedure, response.status);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
