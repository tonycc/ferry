import { ElMessage } from "element-plus";

/**
 * 复制文本到剪贴板。
 * 企业内网早期可能用 HTTP 访问控制台(非 localhost 时 navigator.clipboard 不可用),
 * 所以提供 textarea + execCommand 的降级兜底,保证两种协议下都能一键复制。
 */
export async function copyText(text: string, successMessage = "已复制到剪贴板"): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ElMessage.success(successMessage);
      return true;
    }
  } catch {
    // 降级到传统方式
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    if (ok) {
      ElMessage.success(successMessage);
      return true;
    }
  } catch {
    // 忽略,交由下面提示
  }
  ElMessage.warning("复制失败,请手动选中复制");
  return false;
}
