import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

// A small zip reader: central directory, stored and deflated entries, zip64.
// Written against Node's own zlib so no package is needed. A zip is untrusted
// input, so anything it can't read exactly is refused with a reason instead of
// being skipped quietly: encryption, other compression methods, entries whose
// real size differs from what their header says.

export class ZipError extends Error {
  override name = "ZipError";
}

export type ZipEntry = {
  /** As stored, forward slashes. */
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
  method: number;
  compressedSize: number;
  size: number;
  headerOffset: number;
};

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export class Zip {
  private readonly file: FileHandle;
  readonly entries: ZipEntry[];

  private constructor(file: FileHandle, entries: ZipEntry[]) {
    this.file = file;
    this.entries = entries;
  }

  static async open(filePath: string): Promise<Zip> {
    const file = await open(filePath, "r");
    try {
      return new Zip(file, await readEntries(file));
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.file.close();
  }

  /** The decompressed bytes of one entry, never more than the size its header declares. */
  async read(entry: ZipEntry): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of this.stream(entry)) {
      chunks.push(chunk);
      total += chunk.length;
    }
    if (total !== entry.size) throw new ZipError(`${entry.name} is ${total} bytes, its header says ${entry.size}`);
    return Buffer.concat(chunks);
  }

  async extract(entry: ZipEntry, destination: string): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true });
    await pipeline(this.stream(entry), counted(entry), createWriteStream(destination, { flags: "wx" }));
  }

  private async *stream(entry: ZipEntry): AsyncGenerator<Buffer> {
    if (entry.method !== 0 && entry.method !== 8) {
      throw new ZipError(`${entry.name} uses compression method ${entry.method}, which this can't read`);
    }
    const local = Buffer.alloc(30);
    await this.file.read(local, 0, 30, entry.headerOffset);
    if (local.readUInt32LE(0) !== LOCAL) throw new ZipError(`${entry.name} has a damaged header`);
    // The local header's name and extra lengths can differ from the central ones.
    const start = entry.headerOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    // end is inclusive; an empty entry reads nothing.
    if (entry.compressedSize === 0) return;
    const source = createReadStream("", { fd: this.file, start, end: start + entry.compressedSize - 1, autoClose: false });
    const body = entry.method === 8 ? source.pipe(createInflateRaw()) : source;
    source.on("error", (error) => body.destroy(error));
    for await (const chunk of body) yield chunk as Buffer;
  }
}

// Stops a lying header: an entry that inflates past its declared size is a
// zip bomb, not a file.
function counted(entry: ZipEntry): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      total += chunk.length;
      done(total > entry.size ? new ZipError(`${entry.name} is larger than its header says (${entry.size} bytes)`) : null, chunk);
    },
    flush(done) {
      done(total === entry.size ? null : new ZipError(`${entry.name} is ${total} bytes, its header says ${entry.size}`));
    },
  });
}

async function readEntries(file: FileHandle): Promise<ZipEntry[]> {
  const { size } = await file.stat();
  // The end record is the last 22 bytes, or up to 64 KB earlier when a comment follows.
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = Buffer.alloc(tailLength);
  await file.read(tail, 0, tailLength, size - tailLength);
  let at = -1;
  for (let i = tailLength - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) {
      at = i;
      break;
    }
  }
  if (at === -1) throw new ZipError("That isn't a zip file (no end-of-archive record)");

  let count = tail.readUInt16LE(at + 10);
  let directorySize = tail.readUInt32LE(at + 12);
  let directoryOffset = tail.readUInt32LE(at + 16);

  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locatorAt = size - tailLength + at - 20;
    const locator = Buffer.alloc(20);
    await file.read(locator, 0, 20, locatorAt);
    if (locatorAt < 0 || locator.readUInt32LE(0) !== EOCD64_LOCATOR) throw new ZipError("Damaged zip64 record");
    const record = Buffer.alloc(56);
    await file.read(record, 0, 56, safe(locator.readBigUInt64LE(8)));
    if (record.readUInt32LE(0) !== EOCD64) throw new ZipError("Damaged zip64 record");
    count = safe(record.readBigUInt64LE(32));
    directorySize = safe(record.readBigUInt64LE(40));
    directoryOffset = safe(record.readBigUInt64LE(48));
  }

  const directory = Buffer.alloc(directorySize);
  await file.read(directory, 0, directorySize, directoryOffset);

  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > directory.length || directory.readUInt32LE(p) !== CENTRAL) throw new ZipError("Damaged zip directory");
    const flags = directory.readUInt16LE(p + 8);
    const method = directory.readUInt16LE(p + 10);
    let compressedSize = directory.readUInt32LE(p + 20);
    let entrySize = directory.readUInt32LE(p + 24);
    const nameLength = directory.readUInt16LE(p + 28);
    const extraLength = directory.readUInt16LE(p + 30);
    const commentLength = directory.readUInt16LE(p + 32);
    const madeBy = directory.readUInt16LE(p + 4) >> 8;
    const attributes = directory.readUInt32LE(p + 38);
    let headerOffset = directory.readUInt32LE(p + 42);
    const utf8 = (flags & 0x800) !== 0;
    const name = directory.toString(utf8 ? "utf8" : "latin1", p + 46, p + 46 + nameLength).replaceAll("\\", "/");
    if (flags & 1) throw new ZipError(`${name} is encrypted`);

    // Fields that didn't fit in 32 bits live in the zip64 extra field, in a fixed order.
    const extraStart = p + 46 + nameLength;
    for (let e = extraStart; e + 4 <= extraStart + extraLength; ) {
      const id = directory.readUInt16LE(e);
      const length = directory.readUInt16LE(e + 2);
      if (id === 1) {
        let q = e + 4;
        if (entrySize === 0xffffffff) {
          entrySize = safe(directory.readBigUInt64LE(q));
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = safe(directory.readBigUInt64LE(q));
          q += 8;
        }
        if (headerOffset === 0xffffffff) headerOffset = safe(directory.readBigUInt64LE(q));
      }
      e += 4 + length;
    }

    // Unix mode lives in the top 16 bits when the zip was made on Unix (host 3).
    const mode = madeBy === 3 ? attributes >>> 16 : 0;
    entries.push({
      name,
      isDirectory: name.endsWith("/"),
      isSymlink: (mode & 0xf000) === 0xa000,
      method,
      compressedSize,
      size: entrySize,
      headerOffset,
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function safe(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("That zip is larger than this can handle");
  return Number(value);
}
