import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

interface ZipEntry {
  name: string;
  flags: number;
  /** 0 不压缩,8 deflate */
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  versionMadeBy: number;
  externalAttr: number;
  localOffset: number;
}

/** 读出 zip 中央目录里的条目(不解压)。不是合法 zip、加密或超出普通 32 位范围时返回 undefined */
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
  if (count === 0xffff || offset === 0xffffffff) return undefined;
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) return undefined;
    const versionMadeBy = data.readUInt16LE(offset + 4);
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const crc = data.readUInt32LE(offset + 16);
    const compressedSize = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const externalAttr = data.readUInt32LE(offset + 38);
    const localOffset = data.readUInt32LE(offset + 42);
    // 拒绝加密条目(bit 0)和 ZIP64 占位值
    if ((flags & 0x01) !== 0 || compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      return undefined;
    }
    if (offset + 46 + nameLength > data.length) return undefined;
    entries.push({
      // Windows 上的工具可能用反斜杠
      name: data.toString("utf8", offset + 46, offset + 46 + nameLength).replaceAll("\\", "/"),
      flags,
      method,
      crc,
      compressedSize,
      size,
      versionMadeBy,
      externalAttr,
      localOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 路径里含有空字节、绝对路径或 .. 上级目录段时视为不安全(防 Zip Slip) */
export function hasUnsafeZipPath(name: string): boolean {
  const slash = name.replaceAll("\\", "/");
  if (!slash || slash.includes("\0") || slash.startsWith("/")) return true;
  return slash.split("/").some((seg) => seg === "..");
}

/** 去掉前导 ./ 和中间多余的 . 段后的干净相对路径(不含尾斜杠时为文件) */
function cleanRelativePath(name: string): string {
  const slash = name.replaceAll("\\", "/");
  const trailingSlash = slash.endsWith("/");
  const clean = slash
    .split("/")
    .filter((seg) => seg !== "" && seg !== ".")
    .join("/");
  return trailingSlash && clean ? `${clean}/` : clean;
}

/** 是否为代码包根目录下的 Dockerfile(含 ./Dockerfile 及大小写变体如 dockerfile) */
export function isRootDockerfile(name: string): boolean {
  return cleanRelativePath(name).toLowerCase() === "dockerfile";
}

/**
 * 读出 zip 里的文件名(只读中央目录,不解压)。用来在收到代码包时检查根目录有没有 app.yaml,
 * 让“多包了一层目录”这类问题在上传时就报出来,而不是等到构建失败。
 * 不是合法 zip 时返回 undefined。
 */
export function zipEntryNames(data: Buffer): string[] | undefined {
  return zipEntries(data)?.map((entry) => entry.name);
}

/** 读出某个条目的压缩字节流切片;本地文件头损坏或越界时返回 undefined */
function rawEntryData(data: Buffer, entry: ZipEntry): Buffer | undefined {
  const local = entry.localOffset;
  if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) return undefined;
  const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
  const end = start + entry.compressedSize;
  if (end > data.length) return undefined;
  return data.subarray(start, end);
}

/** 解压单个条目内容;超过 maxBytes 或压缩方式不支持时返回 undefined */
function decodeEntry(data: Buffer, entry: ZipEntry, maxBytes: number): Buffer | undefined {
  if (entry.size > maxBytes || entry.compressedSize > maxBytes) return undefined;
  const raw = rawEntryData(data, entry);
  if (!raw) return undefined;
  if (entry.method === 0) {
    return raw.length === entry.size ? Buffer.from(raw) : undefined;
  }
  if (entry.method !== 8) return undefined;
  try {
    const out = inflateRawSync(raw, { maxOutputLength: maxBytes });
    return out.length === entry.size ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读出 zip 根目录下一个小文件的内容(用来读 app.yaml)。
 * 没有这个文件、超过 maxBytes、或用了不支持的压缩方式时返回 undefined。
 */
export function readZipFile(data: Buffer, name: string, maxBytes = 64 * 1024): Buffer | undefined {
  const entry = zipEntries(data)?.find((e) => !hasUnsafeZipPath(e.name) && cleanRelativePath(e.name) === name);
  if (!entry) return undefined;
  return decodeEntry(data, entry, maxBytes);
}

/**
 * 读出 zip 根目录下所有 Dockerfile(含 ./Dockerfile 和大小写变体)的文本内容。
 * 用于判断上传者是否传入了与模板不同的自定义 Dockerfile。
 */
export function readRootDockerfiles(data: Buffer, maxBytes = 64 * 1024): string[] | undefined {
  const entries = zipEntries(data);
  if (!entries) return undefined;
  const texts: string[] = [];
  for (const entry of entries) {
    if (hasUnsafeZipPath(entry.name) || !isRootDockerfile(entry.name)) continue;
    const buf = decodeEntry(data, entry, maxBytes);
    if (!buf) return undefined;
    texts.push(buf.toString("utf8"));
  }
  return texts;
}

/**
 * 强制托管 Dockerfile:剥离原 zip 中所有根目录 Dockerfile(含 ./Dockerfile、大小写变体和重复条目),
 * 重建干净一致的 Local File Header 与中央目录(消除 Local/Central 文件名不一致及夹带数据),
 * 最后注入平台内置受信任模板的唯一根目录 Dockerfile。
 * 原 zip 含有不安全路径、加密或非标准压缩算法(非 0/8)时返回 undefined。
 */
export function replaceZipDockerfile(data: Buffer, dockerfile: string | Buffer): Buffer | undefined {
  const entries = zipEntries(data);
  if (!entries) return undefined;

  interface PackedItem {
    nameBuf: Buffer;
    flags: number;
    method: number;
    crc: number;
    compressed: Buffer;
    uncompressedSize: number;
    versionMadeBy: number;
    externalAttr: number;
  }

  const items: PackedItem[] = [];
  for (const entry of entries) {
    if (hasUnsafeZipPath(entry.name)) return undefined;
    if (isRootDockerfile(entry.name)) continue;
    if (entry.method !== 0 && entry.method !== 8) return undefined;
    const cleanName = cleanRelativePath(entry.name);
    if (!cleanName) continue;
    const raw = rawEntryData(data, entry);
    if (!raw) return undefined;
    items.push({
      nameBuf: Buffer.from(cleanName, "utf8"),
      // 保留 UTF-8 文件名标记(bit 11 = 0x0800);清除 bit 3(Data Descriptor),大小直接写进新的 Local Header
      flags: 0x0800,
      method: entry.method,
      crc: entry.crc,
      compressed: raw,
      uncompressedSize: entry.size,
      versionMadeBy: entry.versionMadeBy || 20,
      externalAttr: entry.externalAttr,
    });
  }

  const dfPlain = typeof dockerfile === "string" ? Buffer.from(dockerfile, "utf8") : Buffer.from(dockerfile);
  items.push({
    nameBuf: Buffer.from("Dockerfile", "utf8"),
    flags: 0x0800,
    // Dockerfile 只有十几行,不压缩直接存储(method 0):既省 CPU,也让测试假平台能按字节匹配标记
    method: 0,
    crc: crc32(dfPlain),
    compressed: dfPlain,
    uncompressedSize: dfPlain.length,
    // Unix(3) << 8 | 20,常规文件权限 0o100644 << 16
    versionMadeBy: (3 << 8) | 20,
    externalAttr: (0o100644 << 16) >>> 0,
  });

  if (items.length > 0xffff) return undefined;

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(item.flags, 6);
    local.writeUInt16LE(item.method, 8);
    local.writeUInt32LE(item.crc, 14);
    local.writeUInt32LE(item.compressed.length, 18);
    local.writeUInt32LE(item.uncompressedSize, 22);
    local.writeUInt16LE(item.nameBuf.length, 26);
    locals.push(local, item.nameBuf, item.compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(item.versionMadeBy, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(item.flags, 8);
    central.writeUInt16LE(item.method, 10);
    central.writeUInt32LE(item.crc, 16);
    central.writeUInt32LE(item.compressed.length, 20);
    central.writeUInt32LE(item.uncompressedSize, 24);
    central.writeUInt16LE(item.nameBuf.length, 28);
    central.writeUInt32LE(item.externalAttr, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, item.nameBuf);

    offset += 30 + item.nameBuf.length + item.compressed.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** 代码包根目录必须有的文件(Dockerfile 由平台按 app.yaml 的 template 强制托管注入) */
const REQUIRED_AT_ROOT = ["app.yaml"];

/** 检查代码包的路径安全与根目录结构;有问题时返回写给 agent 的修复说明 */
export function checkArchiveLayout(names: string[]): string | undefined {
  if (names.some(hasUnsafeZipPath)) {
    return "代码包里含有非法文件路径(如绝对路径或 .. 上级目录)。请进入应用目录后再打包(例如 cd 应用目录 && zip -r ../app.zip .),然后重新上传";
  }
  const normalized = names.map(cleanRelativePath).filter(Boolean);
  const files = new Set(normalized);
  // 同时有 app.yaml 和 ./app.yaml 时,Ferry 读的和构建时解压出来的可能不是同一份
  const duplicated = REQUIRED_AT_ROOT.filter((file) => normalized.filter((name) => name === file).length > 1);
  if (duplicated.length > 0) {
    return `代码包根目录有不止一个 ${duplicated.join("、")}(比如同时有 app.yaml 和 ./app.yaml)。请在应用目录里重新打包,然后重新上传`;
  }
  const missing = REQUIRED_AT_ROOT.filter((file) => !files.has(file));
  if (missing.length === 0) return undefined;

  // 常见错误:在上一级目录打包,所有文件都在一个子目录里
  const dir = [...files].filter((name) => name.endsWith("/app.yaml")).map((name) => name.slice(0, -"app.yaml".length))[0];
  if (dir) {
    return `代码包多了一层目录 ${dir}:app.yaml 必须在 zip 的根目录。请进入应用目录后再打包(例如 cd 应用目录 && zip -r ../app.zip .),然后重新上传`;
  }
  return `代码包根目录缺少 ${missing.join("、")}。请在应用目录里打包,确保 zip 根目录有 app.yaml,然后重新上传`;
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
