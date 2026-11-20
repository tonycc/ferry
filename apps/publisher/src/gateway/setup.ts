import type { DeployPlatform } from "../adapters/types";
import type { PublisherService } from "../service";

interface Logger {
  info(message: string): void;
  error(message: string): void;
}

/**
 * 启动时写入登录网关配置,并让已有应用的域名都挂上网关。
 *
 * 失败时(比如 Dokploy 正在重启、API key 不对)不能让 Ferry 退出:所有应用都要经过 Ferry 的 /authz,
 * Ferry 起不来等于所有应用都打不开。Traefik 会继续用上次写入的网关配置,这里记日志并定时重试,直到成功。
 */
export async function setupGateway(
  platform: DeployPlatform,
  service: PublisherService,
  authAddress: string,
  log: Logger,
  options: { retryMs?: number; schedule?: (retry: () => void, ms: number) => void } = {},
): Promise<boolean> {
  const retryMs = options.retryMs ?? 60_000;
  const schedule = options.schedule ?? ((retry, ms) => setTimeout(retry, ms).unref());
  let networks: { networks: number; warnings: string[] };
  try {
    await platform.ensureGateway({ authAddress });
    // 网络隔离:网关要接入每个应用的网络才转发得到;网关容器被重建过的话,这里接回去
    networks = await platform.ensureGatewayNetworks();
  } catch (err) {
    log.error(`写入登录网关配置失败,${Math.round(retryMs / 1000)} 秒后重试: ${(err as Error).message}`);
    schedule(() => void setupGateway(platform, service, authAddress, log, options), retryMs);
    return false;
  }
  const { checked, failed } = await service.ensureDomains((name, err) =>
    log.error(`应用 ${name} 的域名没能挂上登录网关,下次发布或重启时再试: ${err.message}`),
  );
  log.info(
    `登录网关已就绪(/authz 地址 ${authAddress}),接入了 ${networks.networks} 个应用网络,` +
      `检查了 ${checked} 个在线应用的域名${failed ? `,其中 ${failed} 个失败` : ""}`,
  );
  for (const warning of networks.warnings) log.error(warning);
  return true;
}
