import { Readable, Transform } from 'node:stream';

const BLOCK = 512;
const USTAR_MAGIC = 'ustar';

export interface TarEntry {
  content: Buffer;
  gid?: number;
  linkname?: string;
  mode?: number;
  name: string;
  type: 'file' | 'directory' | 'symlink';
  uid?: number;
}

const writeOctal = (header: Buffer, offset: number, length: number, value: number) => {
  const octal = Math.max(0, value).toString(8);
  const body =
    octal.length > length - 1 ? octal.slice(-(length - 1)) : octal.padStart(length - 1, '0');
  header.write(body, offset, length - 1, 'latin1');
  header[offset + length - 1] = 0;
};

const USTAR_NAME_SIZE = 100;
const USTAR_PREFIX_SIZE = 155;
/** Usable bytes in a NUL-terminated ustar name/prefix field. */
const USTAR_NAME_MAX = USTAR_NAME_SIZE - 1;
const USTAR_PREFIX_MAX = USTAR_PREFIX_SIZE - 1;

const utf8Len = (value: string) => Buffer.byteLength(value, 'utf8');

/**
 * Truncate `value` to at most `maxBytes` of UTF-8, never splitting a codepoint.
 */
const truncateUtf8 = (value: string, maxBytes: number): string => {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
};

/**
 * Write a UTF-8 string into a ustar header field. Callers must pass a string
 * that already fits (`utf8Len(value) <= length - 1`); never cut mid-sequence.
 */
const writeString = (header: Buffer, offset: number, length: number, value: string) => {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length - 1) {
    throw new Error(`ustar field exceeds ${length - 1} bytes`);
  }
  bytes.copy(header, offset);
};

const checksum = (header: Buffer) => {
  let sum = 0;
  for (const byte of header) sum += byte;
  return sum;
};

/**
 * Split a path into ustar `prefix` (≤154 bytes) + `name` (≤99 bytes).
 * Returns `undefined` when no slash-split fits — caller must emit PAX.
 */
const splitName = (name: string): { name: string; prefix: string } | undefined => {
  if (utf8Len(name) <= USTAR_NAME_MAX) return { name, prefix: '' };

  const parts = name.split('/');
  let prefix = '';
  let rest = name;

  while (parts.length > 1 && utf8Len(rest) > USTAR_NAME_MAX) {
    const head = parts[0] ?? '';
    const nextPrefix = prefix ? `${prefix}/${head}` : head;
    if (utf8Len(nextPrefix) > USTAR_PREFIX_MAX) break;
    parts.shift();
    prefix = nextPrefix;
    rest = parts.join('/');
  }

  if (utf8Len(rest) <= USTAR_NAME_MAX && utf8Len(prefix) <= USTAR_PREFIX_MAX) {
    return { name: rest, prefix };
  }
  return undefined;
};

const formatPaxRecord = (keyword: string, value: string): Buffer => {
  const suffix = Buffer.from(` ${keyword}=${value}\n`, 'utf8');
  let length = suffix.length + 1;
  let record = Buffer.concat([Buffer.from(String(length), 'ascii'), suffix]);
  while (record.length !== length) {
    length = record.length;
    record = Buffer.concat([Buffer.from(String(length), 'ascii'), suffix]);
  }
  return record;
};

const paxHeaderUstarName = (target: string): string => {
  const base = target.split('/').pop() || 'file';
  const dir = 'PaxHeaders.0/';
  const budget = USTAR_NAME_MAX - utf8Len(dir);
  return dir + (truncateUtf8(base, budget) || 'file');
};

const parsePaxPath = (data: Buffer): string | undefined => {
  let offset = 0;
  let path: string | undefined;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space <= offset) break;
    const len = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = data.subarray(offset, Math.min(offset + len, data.length));
    const eq = record.indexOf(0x3d);
    if (eq === -1) break;
    const key = record.subarray(space - offset + 1, eq).toString('utf8');
    const end = record.at(-1) === 0x0a ? record.length - 1 : record.length;
    if (key === 'path') path = record.subarray(eq + 1, end).toString('utf8');
    offset += len;
  }
  return path;
};

interface UstarHeaderFields {
  gid?: number;
  linkname?: string;
  mode: number;
  name: string;
  prefix: string;
  size: number;
  typeflag: string;
  uid?: number;
}

const writeHeader = (fields: UstarHeaderFields): Buffer => {
  const header = Buffer.alloc(BLOCK);

  writeString(header, 0, USTAR_NAME_SIZE, fields.name);
  writeOctal(header, 100, 8, fields.mode);
  writeOctal(header, 108, 8, fields.uid ?? 0);
  writeOctal(header, 116, 8, fields.gid ?? 0);
  writeOctal(header, 124, 12, fields.size);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header.write(fields.typeflag, 156, 1, 'latin1');
  if (fields.linkname) writeString(header, 157, USTAR_NAME_SIZE, fields.linkname);
  header.write(USTAR_MAGIC, 257, 5, 'latin1');
  header[262] = 0;
  header.write('00', 263, 2, 'latin1');
  writeString(header, 345, USTAR_PREFIX_SIZE, fields.prefix);

  const sum = checksum(header);
  const sumField = `${sum.toString(8).padStart(6, '0')}\0 `;
  header.write(sumField, 148, 8, 'latin1');

  return header;
};

const pushPaddedContent = (chunks: Buffer[], content: Buffer) => {
  chunks.push(content);
  const pad = padToBlock(content.length);
  if (pad > 0) chunks.push(Buffer.alloc(pad));
};

const padToBlock = (size: number) => {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
};

export const packTar = (entries: TarEntry[]): Buffer => {
  const chunks: Buffer[] = [];

  for (const entry of entries) {
    const normalized = entry.name.replaceAll(/^\/+/g, '');
    const split = splitName(normalized);
    const typeflag = entry.type === 'directory' ? '5' : entry.type === 'symlink' ? '2' : '0';
    const mode = entry.mode ?? (entry.type === 'directory' ? 0o755 : 0o644);
    const size = entry.type === 'file' ? entry.content.length : 0;

    if (!split) {
      const paxBody = formatPaxRecord('path', normalized);
      chunks.push(
        writeHeader({
          gid: entry.gid,
          mode: 0o644,
          name: paxHeaderUstarName(normalized),
          prefix: '',
          size: paxBody.length,
          typeflag: 'x',
          uid: entry.uid,
        }),
      );
      pushPaddedContent(chunks, paxBody);
    }

    chunks.push(
      writeHeader({
        gid: entry.gid,
        linkname: entry.linkname,
        mode,
        name: split?.name ?? (truncateUtf8(normalized, USTAR_NAME_MAX) || 'file'),
        prefix: split?.prefix ?? '',
        size,
        typeflag,
        uid: entry.uid,
      }),
    );

    if (entry.type === 'file' && entry.content.length > 0) {
      pushPaddedContent(chunks, entry.content);
    }
  }

  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
};

export const packTarFile = (name: string, content: Buffer | string, mode = 0o644): Buffer => {
  const body = typeof content === 'string' ? Buffer.from(content) : content;
  return packTarFiles([{ content: body, mode, name }]);
};

/**
 * Pack many files into one ustar archive, emitting intermediate directory
 * entries so `putArchive` can create nested paths in a single call.
 */
export const packTarFiles = (
  files: Array<{ content: Buffer; gid?: number; mode?: number; name: string; uid?: number }>,
): Buffer => {
  const dirs = new Set<string>();
  const entries: TarEntry[] = [];

  for (const file of files) {
    const normalized = file.name.replaceAll(/^\/+/g, '');
    const parts = normalized.split('/').filter(Boolean);
    let prefix = '';

    for (const [index, part] of parts.entries()) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (index < parts.length - 1) {
        if (dirs.has(prefix)) continue;
        dirs.add(prefix);
        entries.push({
          content: Buffer.alloc(0),
          gid: file.gid,
          mode: 0o755,
          name: prefix,
          type: 'directory',
          uid: file.uid,
        });
      } else {
        entries.push({
          content: file.content,
          gid: file.gid,
          mode: file.mode ?? 0o644,
          name: prefix,
          type: 'file',
          uid: file.uid,
        });
      }
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
  let paxPath: string | undefined;

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

    if (typeflag === 'x') {
      paxPath = parsePaxPath(data) ?? paxPath;
      continue;
    }

    const resolvedName = paxPath ?? fullName;
    paxPath = undefined;

    if (typeflag === '5') {
      entries.push({ content: Buffer.alloc(0), name: resolvedName, type: 'directory' });
    } else if (typeflag === '2') {
      entries.push({ content: Buffer.alloc(0), linkname, name: resolvedName, type: 'symlink' });
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      entries.push({ content: Buffer.from(data), name: resolvedName, type: 'file' });
    }
  }

  return entries;
};

/**
 * Stream the first regular-file payload (optionally matching `basename`) out of
 * a ustar archive without buffering the whole archive or file in memory.
 */
export const createTarFileExtractStream = (options: {
  basename?: string;
  expectedSize: number;
}): Transform => {
  const { basename, expectedSize } = options;
  let leftover = Buffer.alloc(0);
  let mode: 'header' | 'emit' | 'skip' | 'done' = 'header';
  let remaining = 0;
  let pad = 0;
  let emitted = 0;

  const matches = (name: string) => {
    if (!basename) return true;
    return name === basename || name.endsWith(`/${basename}`);
  };

  return new Transform({
    flush(callback) {
      if (mode === 'emit' && emitted < expectedSize) {
        callback(new Error('truncated tar archive while extracting export'));
        return;
      }
      callback();
    },
    transform(chunk: Buffer, _encoding, callback) {
      leftover = Buffer.concat([leftover, chunk]);
      try {
        while (leftover.length > 0 && mode !== 'done') {
          if (mode === 'header') {
            if (leftover.length < BLOCK) break;
            const header = leftover.subarray(0, BLOCK);
            leftover = leftover.subarray(BLOCK);
            if (header.every((byte) => byte === 0)) {
              mode = 'done';
              this.push(null);
              break;
            }
            const name = readCString(header, 0, 100);
            const prefix = readCString(header, 345, 155);
            const fullName = prefix ? `${prefix}/${name}` : name;
            const typeflag = String.fromCodePoint(header[156] ?? 48);
            const size = readOctal(header, 124, 12);
            const isFile = typeflag === '0' || typeflag === '\0' || typeflag === '7';
            if (isFile && matches(fullName)) {
              remaining = size;
              pad = padToBlock(size);
              mode = 'emit';
            } else {
              remaining = size;
              pad = padToBlock(size);
              mode = 'skip';
            }
            continue;
          }

          if (mode === 'emit') {
            if (remaining > 0) {
              const take = Math.min(remaining, leftover.length, expectedSize - emitted);
              if (take > 0) {
                this.push(leftover.subarray(0, take));
                leftover = leftover.subarray(take);
                remaining -= take;
                emitted += take;
              }
              if (emitted >= expectedSize) {
                this.push(null);
                mode = 'done';
                leftover = Buffer.alloc(0);
                break;
              }
              if (remaining > 0) break;
            }
            if (pad > 0) {
              const drop = Math.min(pad, leftover.length);
              leftover = leftover.subarray(drop);
              pad -= drop;
              if (pad > 0) break;
            }
            mode = 'done';
            this.push(null);
            leftover = Buffer.alloc(0);
            break;
          }

          if (mode === 'skip') {
            const drop = Math.min(remaining + pad, leftover.length);
            leftover = leftover.subarray(drop);
            if (drop >= remaining) {
              pad -= drop - remaining;
              remaining = 0;
              if (pad <= 0) mode = 'header';
            } else {
              remaining -= drop;
              break;
            }
          }
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
};

export const asWebReadable = (stream: Readable): ReadableStream<Uint8Array> =>
  Readable.toWeb(stream) as ReadableStream<Uint8Array>;

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
