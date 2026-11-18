/**
 * 读出 zip 里的文件名(只读中央目录,不解压)。用来在收到代码包时检查根目录有没有 app.yaml 和 Dockerfile,
 * 让“多包了一层目录”这类问题在上传时就报出来,而不是等到构建失败。
 * 不是合法 zip 时返回 undefined。
 */
export function zipEntryNames(data: Buffer): string[] | undefined {
  // 中央目录结束记录在文件末尾,后面最多跟 65535 字节的注释
  const EOCD = 0x06054b50;
  const minStart = Math.max(0, data.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = data.length - 22; i >= minStart; i--) {
    if (data.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;

  const count = data.readUInt16LE(eocd + 10);
  let offset = data.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let n = 0; n < count; n++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) return undefined;
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    if (offset + 46 + nameLength > data.length) return undefined;
    // Windows 上的工具可能用反斜杠
    names.push(data.toString("utf8", offset + 46, offset + 46 + nameLength).replaceAll("\\", "/"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** 代码包根目录必须有的文件 */
const REQUIRED_AT_ROOT = ["app.yaml", "Dockerfile"];

/** 检查代码包的根目录;有问题时返回写给 agent 的修复说明 */
export function checkArchiveLayout(names: string[]): string | undefined {
  const files = new Set(names.map((name) => name.replace(/^\.\//, "")));
  const missing = REQUIRED_AT_ROOT.filter((file) => !files.has(file));
  if (missing.length === 0) return undefined;

  // 常见错误:在上一级目录打包,所有文件都在一个子目录里
  const dir = [...files]
    .filter((name) => name.endsWith("/app.yaml"))
    .map((name) => name.slice(0, -"app.yaml".length))
    .find((prefix) => files.has(`${prefix}Dockerfile`));
  if (dir) {
    return `代码包多了一层目录 ${dir}:app.yaml 和 Dockerfile 必须在 zip 的根目录。请进入应用目录后再打包(例如 cd 应用目录 && zip -r ../app.zip .),然后重新上传`;
  }
  return `代码包根目录缺少 ${missing.join("、")}。请在应用目录里打包,确保 zip 根目录有 app.yaml 和 Dockerfile,然后重新上传`;
}
