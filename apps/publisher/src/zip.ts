import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

interface ZipEntry {
  name: string;
  /** 0 不压缩,8 deflate */
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** 读出 zip 中央目录里的条目(不解压)。不是合法 zip 时返回 undefined */
function zipEntries(data: Buffer): ZipEntry[] | undefined {
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
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) return undefined;
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    if (offset + 46 + nameLength > data.length) return undefined;
    entries.push({
      // Windows 上的工具可能用反斜杠
      name: data.toString("utf8", offset + 46, offset + 46 + nameLength).replaceAll("\\", "/"),
      method: data.readUInt16LE(offset + 10),
      compressedSize: data.readUInt32LE(offset + 20),
      size: data.readUInt32LE(offset + 24),
      localOffset: data.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * 读出 zip 里的文件名(只读中央目录,不解压)。用来在收到代码包时检查根目录有没有 app.yaml 和 Dockerfile,
 * 让“多包了一层目录”这类问题在上传时就报出来,而不是等到构建失败。
 * 不是合法 zip 时返回 undefined。
 */
export function zipEntryNames(data: Buffer): string[] | undefined {
  return zipEntries(data)?.map((entry) => entry.name);
}

/**
 * 读出 zip 根目录下一个小文件的内容(用来读 app.yaml)。
 * 没有这个文件、超过 maxBytes、或用了不支持的压缩方式时返回 undefined。
 */
export function readZipFile(data: Buffer, name: string, maxBytes = 64 * 1024): Buffer | undefined {
  const entry = zipEntries(data)?.find((e) => e.name.replace(/^\.\//, "") === name);
  if (!entry || entry.size > maxBytes || entry.compressedSize > maxBytes) return undefined;
  const local = entry.localOffset;
  if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) return undefined;
  const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
  const end = start + entry.compressedSize;
  if (end > data.length) return undefined;
  const raw = data.subarray(start, end);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method !== 8) return undefined;
  try {
    return inflateRawSync(raw, { maxOutputLength: maxBytes });
  } catch {
    return undefined;
  }
}

/** 代码包根目录必须有的文件 */
const REQUIRED_AT_ROOT = ["app.yaml", "Dockerfile"];

/** 检查代码包的根目录;有问题时返回写给 agent 的修复说明 */
export function checkArchiveLayout(names: string[]): string | undefined {
  const normalized = names.map((name) => name.replace(/^\.\//, ""));
  const files = new Set(normalized);
  // 同时有 app.yaml 和 ./app.yaml 时,Ferry 读的和构建时解压出来的可能不是同一份
  const duplicated = REQUIRED_AT_ROOT.filter((file) => normalized.filter((name) => name === file).length > 1);
  if (duplicated.length > 0) {
    return `代码包根目录有不止一个 ${duplicated.join("、")}(比如同时有 app.yaml 和 ./app.yaml)。请在应用目录里重新打包,然后重新上传`;
  }
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

/** 生成 zip(设置向导的自检用它打包模板;测试默认不压缩,内容原样出现在字节里,假平台靠它识别标记) */
export function makeZip(files: Record<string, string | Buffer>, options: { deflate?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const plain = typeof text === "string" ? Buffer.from(text, "utf8") : text;
    const crc = crc32(plain);
    const method = options.deflate ? 8 : 0;
    const data = options.deflate ? deflateRawSync(plain) : plain;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
