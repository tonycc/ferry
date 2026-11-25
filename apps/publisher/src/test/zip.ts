import { makeZip } from "../zip";

export { makeZip };

/** 根目录有 app.yaml 和 Dockerfile 的最小代码包;marker 放在 Dockerfile 里 */
export function appZip(manifest: string, marker = ""): Buffer {
  return makeZip({ "app.yaml": manifest, Dockerfile: `FROM scratch\n# ${marker}\n` });
}
