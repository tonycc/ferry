import { ref } from "vue";
import { api, type CertificateStatus } from "./api";

/** 证书状态:顶部提醒和证书页共用一份,证书页装好新证书后更新它,提醒跟着变 */
export const certificateStatus = ref<CertificateStatus>();

/** 读一次证书状态。本机开发没有正式地址时接口 404,这时是 undefined;其他错误抛出 */
export async function loadCertificateStatus(): Promise<CertificateStatus | undefined> {
  certificateStatus.value = await api.get<CertificateStatus>("/api/admin/certificate");
  return certificateStatus.value;
}
