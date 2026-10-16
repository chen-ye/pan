import { basename, join } from "@std/path";
import { CONFIG } from "../config.ts";

export interface FragmentInfo {
  offset: number;
  length: number;
  decodeTime: number;
  duration?: number;
}

export interface ParseResult {
  timescale: number;
  initSize: number;
  fragments: FragmentInfo[];
}

export class M3u8Service {
  private inFlight = new Map<string, Promise<string | null>>();

  /**
   * Parses an fMP4 file to extract its initialization segment and fragment byte ranges.
   * If the file is not a fragmented MP4 (no moof atoms), returns null.
   */
  async parseFmp4(filePath: string): Promise<ParseResult | null> {
    let file: Deno.FsFile | null = null;
    try {
      file = await Deno.open(filePath, { read: true });
      const fileInfo = await file.stat();
      const fileSize = fileInfo.size;

      let offset = 0;
      let initSize = 0;
      let timescale = 1000;
      const fragments: FragmentInfo[] = [];

      // Reusable 8KB buffer to read box headers and small payloads (like moof + mdat header) in a single read syscall
      const chunkBuf = new Uint8Array(8192);

      while (offset < fileSize) {
        await file.seek(offset, Deno.SeekMode.Start);
        const bytesRead = await file.read(chunkBuf);
        if (!bytesRead || bytesRead < 8) break;

        const view = new DataView(chunkBuf.buffer, chunkBuf.byteOffset, bytesRead);
        let size = view.getUint32(0);
        const tag = String.fromCharCode(
          chunkBuf[4],
          chunkBuf[5],
          chunkBuf[6],
          chunkBuf[7],
        );

        let headerLen = 8;
        if (size === 1) {
          // Extended 64-bit size
          if (bytesRead < 16) break;
          size = Number(view.getBigUint64(8));
          headerLen = 16;
        } else if (size === 0) {
          // Box extends to EOF
          size = fileSize - offset;
        }

        if (size < headerLen) break; // Corrupt atom size

        if (tag === "moov") {
          initSize = offset + size;
          // Read moov payload to extract timescale from mdhd
          const payloadSize = size - headerLen;
          if (payloadSize > 0 && payloadSize < 10 * 1024 * 1024) { // safety cap 10MB
            let moovPayload: Uint8Array;
            if (headerLen + payloadSize <= bytesRead) {
              moovPayload = chunkBuf.subarray(headerLen, headerLen + payloadSize);
            } else {
              moovPayload = new Uint8Array(payloadSize);
              await file.seek(offset + headerLen, Deno.SeekMode.Start);
              await file.read(moovPayload);
            }
            const ts = this.extractTimescale(moovPayload);
            if (ts) timescale = ts;
          }
        } else if (tag === "moof") {
          const moofOffset = offset;
          const moofSize = size;
          const payloadSize = moofSize - headerLen;

          // Read moof payload to extract decode_time from tfdt and sample duration from trun
          let decodeTime = 0;
          let duration: number | undefined;

          let moofPayload: Uint8Array | null = null;
          if (headerLen + payloadSize <= bytesRead) {
            moofPayload = chunkBuf.subarray(headerLen, headerLen + payloadSize);
          } else if (payloadSize > 0 && payloadSize < 1024 * 1024) { // safety cap 1MB
            moofPayload = new Uint8Array(payloadSize);
            await file.seek(offset + headerLen, Deno.SeekMode.Start);
            await file.read(moofPayload);
          }

          if (moofPayload) {
            const dt = this.extractDecodeTime(moofPayload);
            if (dt !== null) decodeTime = dt;
            const trunDur = this.extractTrunDuration(moofPayload);
            if (trunDur !== null && trunDur > 0 && timescale > 0) {
              duration = trunDur / timescale;
            }
          }

          // Check if next box is mdat
          let mdatSize: number | null = null;
          let mdatTag: string | null = null;
          const mdatRelOffset = moofSize;

          if (mdatRelOffset + 8 <= bytesRead) {
            let mSize = view.getUint32(mdatRelOffset);
            mdatTag = String.fromCharCode(
              chunkBuf[mdatRelOffset + 4],
              chunkBuf[mdatRelOffset + 5],
              chunkBuf[mdatRelOffset + 6],
              chunkBuf[mdatRelOffset + 7],
            );
            if (mSize === 1) {
              if (mdatRelOffset + 16 <= bytesRead) {
                mSize = Number(view.getBigUint64(mdatRelOffset + 8));
              }
            } else if (mSize === 0) {
              mSize = fileSize - (offset + moofSize);
            }
            mdatSize = mSize;
          } else {
            const mdatOffset = offset + moofSize;
            await file.seek(mdatOffset, Deno.SeekMode.Start);
            const mdatHdr = new Uint8Array(16);
            const mdatRead = await file.read(mdatHdr.subarray(0, 8));
            if (mdatRead && mdatRead >= 8) {
              const mdatView = new DataView(mdatHdr.buffer);
              let mSize = mdatView.getUint32(0);
              mdatTag = String.fromCharCode(
                mdatHdr[4],
                mdatHdr[5],
                mdatHdr[6],
                mdatHdr[7],
              );
              if (mSize === 1) {
                await file.read(mdatHdr.subarray(8, 16));
                mSize = Number(mdatView.getBigUint64(8));
              } else if (mSize === 0) {
                mSize = fileSize - mdatOffset;
              }
              mdatSize = mSize;
            }
          }

          if (mdatTag === "mdat" && mdatSize !== null) {
            const fragLength = moofSize + mdatSize;
            fragments.push({
              offset: moofOffset,
              length: fragLength,
              decodeTime,
              duration,
            });

            // Advance offset past this entire fragment (moof + mdat)
            offset += fragLength;
            continue;
          }
        }

        offset += size;
      }

      if (fragments.length === 0) {
        return null;
      }

      return {
        timescale,
        initSize: initSize > 0 ? initSize : fragments[0].offset,
        fragments,
      };
    } finally {
      if (file) {
        try {
          file.close();
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Helper to extract timescale from moov box bytes by searching for mdhd.
   */
  private extractTimescale(moovData: Uint8Array): number | null {
    // Search for "mdhd" box
    for (let i = 0; i <= moovData.length - 24; i++) {
      if (
        moovData[i] === 0x6d && // 'm'
        moovData[i + 1] === 0x64 && // 'd'
        moovData[i + 2] === 0x68 && // 'h'
        moovData[i + 3] === 0x64 // 'd'
      ) {
        const ver = moovData[i + 4];
        const view = new DataView(moovData.buffer, moovData.byteOffset + i);
        if (ver === 1) {
          // 4 (mdhd) + 1 (ver) + 3 (flags) + 8 (creation) + 8 (mod) = 24
          return view.getUint32(24);
        } else {
          // 4 (mdhd) + 1 (ver) + 3 (flags) + 4 (creation) + 4 (mod) = 16
          return view.getUint32(16);
        }
      }
    }
    return null;
  }

  /**
   * Helper to extract decode time from moof box bytes by searching for tfdt.
   */
  private extractDecodeTime(moofData: Uint8Array): number | null {
    // Search for "tfdt" box
    for (let i = 0; i <= moofData.length - 16; i++) {
      if (
        moofData[i] === 0x74 && // 't'
        moofData[i + 1] === 0x66 && // 'f'
        moofData[i + 2] === 0x64 && // 'd'
        moofData[i + 3] === 0x74 // 't'
      ) {
        const ver = moofData[i + 4];
        const view = new DataView(moofData.buffer, moofData.byteOffset + i);
        if (ver === 1) {
          // 4 (tfdt) + 1 (ver) + 3 (flags) = 8
          return Number(view.getBigUint64(8));
        } else {
          return view.getUint32(8);
        }
      }
    }
    return null;
  }

  /**
   * Helper to extract total duration of a fragment from its trun box.
   */
  private extractTrunDuration(moofData: Uint8Array): number | null {
    for (let i = 0; i <= moofData.length - 16; i++) {
      if (
        moofData[i] === 0x74 && // 't'
        moofData[i + 1] === 0x72 && // 'r'
        moofData[i + 2] === 0x75 && // 'u'
        moofData[i + 3] === 0x6e // 'n'
      ) {
        const view = new DataView(moofData.buffer, moofData.byteOffset + i);
        const flags = (moofData[i + 5] << 16) | (moofData[i + 6] << 8) | moofData[i + 7];
        const sampleCount = view.getUint32(8);

        let p = 12;
        if (flags & 0x000001) p += 4; // data-offset
        if (flags & 0x000004) p += 4; // first-sample-flags

        let durSum = 0;
        const hasDur = !!(flags & 0x000100);
        const hasSize = !!(flags & 0x000200);
        const hasFlags = !!(flags & 0x000400);
        const hasCtts = !!(flags & 0x000800);

        const sampleSize = (hasDur ? 4 : 0) + (hasSize ? 4 : 0) + (hasFlags ? 4 : 0) + (hasCtts ? 4 : 0);

        if (hasDur) {
          for (let s = 0; s < sampleCount && p + 4 <= moofData.length; s++) {
            durSum += view.getUint32(p);
            p += sampleSize;
          }
          return durSum;
        }
        return null;
      }
    }
    return null;
  }

  /**
   * Generates standard HLS Byte-Range playlist (RFC 8216) content.
   */
  buildM3u8Content(result: ParseResult, mediaUri: string): string {
    const { timescale, initSize, fragments } = result;

    let maxDuration = 1.0;
    const segmentEntries: { duration: number; length: number; offset: number }[] = [];

    for (let i = 0; i < fragments.length; i++) {
      let duration = 1.0;
      if (fragments[i].duration && fragments[i].duration! > 0) {
        duration = fragments[i].duration!;
      } else if (i + 1 < fragments.length && fragments[i + 1].decodeTime > fragments[i].decodeTime) {
        duration = (fragments[i + 1].decodeTime - fragments[i].decodeTime) / timescale;
      } else if (segmentEntries.length > 0) {
        duration = segmentEntries[segmentEntries.length - 1].duration;
      }

      if (duration <= 0 || isNaN(duration)) {
        duration = 1.0;
      }

      if (duration > maxDuration) {
        maxDuration = duration;
      }

      segmentEntries.push({
        duration,
        length: fragments[i].length,
        offset: fragments[i].offset,
      });
    }

    const lines: string[] = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      `#EXT-X-MAP:URI="${mediaUri}",BYTERANGE="${initSize}@0"`,
      "",
    ];

    for (const seg of segmentEntries) {
      lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
      lines.push(`#EXT-X-BYTERANGE:${seg.length}@${seg.offset}`);
      lines.push(mediaUri);
    }

    lines.push("#EXT-X-ENDLIST");
    return lines.join("\n") + "\n";
  }

  /**
   * Retrieves an existing .m3u8 sidecar or generates and writes it to disk.
   */
  async getOrGenerateSidecar(relVideoPath: string): Promise<string | null> {
    if (relVideoPath.includes("..")) return null;

    const fullVideoPath = join(CONFIG.DATA_DIR, relVideoPath);
    const sidecarPath = fullVideoPath + ".m3u8";

    // 1. Try reading existing sidecar
    try {
      const content = await Deno.readTextFile(sidecarPath);
      if (content.length > 0) return content;
    } catch {
      // Sidecar does not exist yet
    }

    // 2. Mutex deduplication to prevent thundering herd
    const existingPromise = this.inFlight.get(relVideoPath);
    if (existingPromise) {
      return await existingPromise;
    }

    const generationPromise = (async () => {
      try {
        const parseResult = await this.parseFmp4(fullVideoPath);
        if (!parseResult) return null;

        const mediaUri = basename(relVideoPath);
        const m3u8Content = this.buildM3u8Content(parseResult, mediaUri);

        // Write sidecar atomically using temporary file (catch write errors so playback works even if storage is read-only)
        try {
          const tmpPath = `${sidecarPath}.tmp.${Date.now()}`;
          await Deno.writeTextFile(tmpPath, m3u8Content);
          await Deno.rename(tmpPath, sidecarPath);
        } catch (writeErr) {
          console.warn(`Failed to write m3u8 sidecar to disk for ${relVideoPath}, serving in-memory:`, writeErr);
        }

        return m3u8Content;
      } catch (err) {
        console.error(`Failed to generate m3u8 sidecar for ${relVideoPath}:`, err);
        throw err;
      } finally {
        this.inFlight.delete(relVideoPath);
      }
    })();

    this.inFlight.set(relVideoPath, generationPromise);
    return await generationPromise;
  }
}

export const m3u8Service = new M3u8Service();
