const BLOCK = 512;
const USTAR_MAGIC = 'ustar';

export interface TarEntry {
  content: Buffer;
  linkname?: string;
  mode?: number;
  name: string;
  type: 'file' | 'directory' | 'symlink';
}

const writeOctal = (header: Buffer, offset: number, length: number, value: number) => {
  const octal = Math.max(0, value).toString(8);
  const body =
    octal.length > length - 1 ? octal.slice(-(length - 1)) : octal.padStart(length - 1, '0');
  header.write(body, offset, length - 1, 'latin1');
  header[offset + length - 1] = 0;
};

const writeString = (header: Buffer, offset: number, length: number, value: string) => {
  const bytes = Buffer.from(value, 'utf8').subarray(0, length - 1);
  bytes.copy(header, offset);
};

const checksum = (header: Buffer) => {
  let sum = 0;
  for (const byte of header) sum += byte;
  return sum;
};

const splitName = (name: string): { name: string; prefix: string } => {
  if (name.length < 100) return { name, prefix: '' };

  const parts = name.split('/');
  let prefix = '';
  let rest = name;

  while (parts.length > 1 && rest.length >= 100) {
    prefix = prefix ? `${prefix}/${parts.shift()}` : (parts.shift() ?? '');
    rest = parts.join('/');
    if (prefix.length > 155) break;
  }

  return { name: rest.slice(0, 100), prefix: prefix.slice(0, 155) };
};

const headerFor = (entry: TarEntry): Buffer => {
  const header = Buffer.alloc(BLOCK);
  const { name, prefix } = splitName(entry.name.replaceAll(/^\/+/g, ''));
  const typeflag = entry.type === 'directory' ? '5' : entry.type === 'symlink' ? '2' : '0';
  const mode = entry.mode ?? (entry.type === 'directory' ? 0o755 : 0o644);
  const size = entry.type === 'file' ? entry.content.length : 0;

  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header.write(typeflag, 156, 1, 'latin1');
  if (entry.linkname) writeString(header, 157, 100, entry.linkname);
  header.write(USTAR_MAGIC, 257, 5, 'latin1');
  header[262] = 0;
  header.write('00', 263, 2, 'latin1');
  writeString(header, 345, 155, prefix);

  const sum = checksum(header);
  const sumField = `${sum.toString(8).padStart(6, '0')}\0 `;
  header.write(sumField, 148, 8, 'latin1');

  return header;
};

const padToBlock = (size: number) => {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
};

export const packTar = (entries: TarEntry[]): Buffer => {
  const chunks: Buffer[] = [];

  for (const entry of entries) {
    chunks.push(headerFor(entry));
    if (entry.type === 'file' && entry.content.length > 0) {
      chunks.push(entry.content);
      const pad = padToBlock(entry.content.length);
      if (pad > 0) chunks.push(Buffer.alloc(pad));
    }
  }

  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
};

export const packTarFile = (name: string, content: Buffer | string, mode = 0o644): Buffer => {
  const body = typeof content === 'string' ? Buffer.from(content) : content;
  const normalized = name.replaceAll(/^\/+/g, '');
  const parts = normalized.split('/').filter(Boolean);
  const entries: TarEntry[] = [];
  let prefix = '';

  for (const [index, part] of parts.entries()) {
    prefix = prefix ? `${prefix}/${part}` : part;
    if (index < parts.length - 1) {
      entries.push({ content: Buffer.alloc(0), name: prefix, type: 'directory', mode: 0o755 });
    } else {
      entries.push({ content: body, name: prefix, type: 'file', mode });
    }
  }

  return packTar(entries);
};

const readCString = (block: Buffer, offset: number, length: number) => {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice
    .subarray(0, end === -1 ? length : end)
    .toString('utf8')
    .trim();
};

const readOctal = (block: Buffer, offset: number, length: number) => {
  const raw = readCString(block, offset, length).replaceAll(/\D/g, '');
  return raw ? Number.parseInt(raw, 8) : 0;
};

export const extractTar = (archive: Buffer): TarEntry[] => {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    offset += BLOCK;

    if (header.every((byte) => byte === 0)) break;

    const name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const typeflag = String.fromCodePoint(header[156] ?? 48);
    const size = readOctal(header, 124, 12);
    const linkname = readCString(header, 157, 100);
    const data = archive.subarray(offset, offset + size);
    offset += size + padToBlock(size);

    if (typeflag === '5') {
      entries.push({ content: Buffer.alloc(0), name: fullName, type: 'directory' });
    } else if (typeflag === '2') {
      entries.push({ content: Buffer.alloc(0), linkname, name: fullName, type: 'symlink' });
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      entries.push({ content: Buffer.from(data), name: fullName, type: 'file' });
    }
  }

  return entries;
};

export const extractTarFile = (archive: Buffer, basename?: string): Buffer => {
  const files = extractTar(archive).filter((entry) => entry.type === 'file');

  if (files.length === 0) {
    throw new Error('archive does not contain a file');
  }

  if (basename) {
    const match = files.find(
      (entry) => entry.name === basename || entry.name.endsWith(`/${basename}`),
    );
    if (match) return match.content;
  }

  return files[0].content;
};
