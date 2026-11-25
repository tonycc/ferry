import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { UserError } from "../errors";
import type { IdentityResolver } from "../identity";
import type { CertificateManager } from "../setup/certificate-manager";

/** PEM 文本;证书链一般几 KB。和向导第 3 步一样 */
const certificateBody = z.object({
  certificate: z.string().max(64 * 1024, "证书文件太大(超过 64 KB):请确认选的是 .pem 或 .crt 证书文件"),
  privateKey: z.string().max(16 * 1024, "私钥文件太大(超过 16 KB):请确认选的是 .key 私钥文件"),
});

/**
 * 控制台的“证书”页(只给平台管理员),以及给所有登录的人看的“是不是 https”(个人令牌页提醒改 MCP 地址)。
 * 上传私钥只能在控制台网页上做,不能用个人令牌(agent)调用
 */
export function registerCertificateRoutes(app: FastifyInstance, certificates: CertificateManager, identity: IdentityResolver): void {
  const admin = async (user: { isAdmin: boolean }) => {
    if (!user.isAdmin) throw new UserError("forbidden", "只有平台管理员能管理证书");
  };

  app.get("/api/admin/certificate", async (req) => {
    await admin(await identity(req, "api"));
    return certificates.status();
  });

  app.post("/api/admin/certificate", async (req) => {
    const user = await identity(req, "console");
    await admin(user);
    const { certificate, privateKey } = certificateBody.parse(req.body);
    return certificates.install(user.id, certificate, privateKey);
  });

  app.get("/api/instance", async (req) => {
    await identity(req, "api");
    return certificates.info();
  });
}
