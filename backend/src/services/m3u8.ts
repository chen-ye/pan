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
  private initCache = new Map<string, Uint8Array>();

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

        if (size < headerLen || offset + size > fileSize) break; // Corrupt atom size or truncated file

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
            if (moofOffset + fragLength > fileSize) {
              // Fragment extends past EOF (file is truncated or corrupt)
              return null;
            }
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
   * Helper to read a 4-character ASCII tag from a buffer.
   */
  private getTag(buf: Uint8Array, offset: number): string {
    return String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
  }

  /**
   * Generates or retrieves a cached video-only initialization segment (ftyp + moov)
   * with any non-video tracks (e.g. audio) stripped out so that browsers initialize
   * a pure video SourceBuffer and avoid timestamp drift crashes.
   */
  async getVideoOnlyInitSegment(filePath: string): Promise<Uint8Array | null> {
    const cached = this.initCache.get(filePath);
    if (cached) return cached;

    let file: Deno.FsFile | null = null;
    try {
      file = await Deno.open(filePath, { read: true });
      const headerBuf = new Uint8Array(32768);
      const bytesRead = await file.read(headerBuf);
      if (!bytesRead || bytesRead < 32) return null;

      const view = new DataView(headerBuf.buffer, headerBuf.byteOffset, bytesRead);
      const ftypLen = view.getUint32(0);
      const ftypTag = this.getTag(headerBuf, 4);
      if (ftypTag !== "ftyp" || ftypLen < 8 || ftypLen > bytesRead) return null;

      const moovOffset = ftypLen;
      if (moovOffset + 8 > bytesRead) return null;

      let moovLen = view.getUint32(moovOffset);
      let moovHeaderLen = 8;
      if (moovLen === 1) {
        moovLen = Number(view.getBigUint64(moovOffset + 8));
        moovHeaderLen = 16;
      }
      const moovTag = this.getTag(headerBuf, moovOffset + 4);
      if (moovTag !== "moov" || moovLen < moovHeaderLen) return null;

      let fullMoov: Uint8Array;
      if (moovOffset + moovLen <= bytesRead) {
        fullMoov = headerBuf.subarray(moovOffset, moovOffset + moovLen);
      } else {
        fullMoov = new Uint8Array(moovLen);
        await file.seek(moovOffset, Deno.SeekMode.Start);
        await file.read(fullMoov);
      }

      const moovView = new DataView(fullMoov.buffer, fullMoov.byteOffset, fullMoov.byteLength);
      let p = moovHeaderLen;
      const moovEnd = moovLen;
      const keptBoxes: Uint8Array[] = [];
      const videoTrackIds = new Set<number>();
      let mvexBox: Uint8Array | null = null;

      while (p + 8 <= moovEnd) {
        const bSize = moovView.getUint32(p);
        const bTag = this.getTag(fullMoov, p + 4);
        if (bSize < 8 || p + bSize > moovEnd) break;

        if (bTag === "trak") {
          const trakBytes = fullMoov.subarray(p, p + bSize);
          let isVideo = false;
          let trackId = 0;

          for (let i = 0; i <= trakBytes.length - 16; i++) {
            if (this.getTag(trakBytes, i) === "hdlr" && i + 16 <= trakBytes.length) {
              const handler = this.getTag(trakBytes, i + 12);
              if (handler === "vide") isVideo = true;
            }
            if (this.getTag(trakBytes, i) === "tkhd" && i + 28 <= trakBytes.length) {
              const ver = trakBytes[i + 4];
              const tkhdView = new DataView(trakBytes.buffer, trakBytes.byteOffset + i);
              trackId = ver === 0 ? tkhdView.getUint32(16) : tkhdView.getUint32(24);
            }
          }

          if (isVideo) {
            videoTrackIds.add(trackId);
            keptBoxes.push(trakBytes);
          }
        } else if (bTag === "mvex") {
          mvexBox = fullMoov.subarray(p, p + bSize);
        } else {
          keptBoxes.push(fullMoov.subarray(p, p + bSize));
        }
        p += bSize;
      }

      if (mvexBox) {
        let q = 8;
        const mvexView = new DataView(mvexBox.buffer, mvexBox.byteOffset, mvexBox.byteLength);
        const keptMvex: Uint8Array[] = [];
        while (q + 8 <= mvexBox.length) {
          const s = mvexView.getUint32(q);
          const t = this.getTag(mvexBox, q + 4);
          if (s < 8 || q + s > mvexBox.length) break;
          if (t === "trex" && q + 16 <= mvexBox.length) {
            const trkId = mvexView.getUint32(q + 12);
            if (videoTrackIds.has(trkId)) {
              keptMvex.push(mvexBox.subarray(q, q + s));
            }
          } else {
            keptMvex.push(mvexBox.subarray(q, q + s));
          }
          q += s;
        }

        const mvexPayloadLen = keptMvex.reduce((acc, b) => acc + b.length, 0);
        const newMvex = new Uint8Array(8 + mvexPayloadLen);
        new DataView(newMvex.buffer).setUint32(0, newMvex.length);
        newMvex.set(new TextEncoder().encode("mvex"), 4);
        let mp = 8;
        for (const b of keptMvex) {
          newMvex.set(b, mp);
          mp += b.length;
        }
        keptBoxes.push(newMvex);
      }

      const moovPayloadLen = keptBoxes.reduce((acc, b) => acc + b.length, 0);
      const newMoov = new Uint8Array(8 + moovPayloadLen);
      new DataView(newMoov.buffer).setUint32(0, newMoov.length);
      newMoov.set(new TextEncoder().encode("moov"), 4);
      let op = 8;
      for (const b of keptBoxes) {
        newMoov.set(b, op);
        op += b.length;
      }

      const out = new Uint8Array(ftypLen + newMoov.length);
      out.set(headerBuf.subarray(0, ftypLen), 0);
      out.set(newMoov, ftypLen);

      // Keep cache bounded (max 500 entries)
      if (this.initCache.size > 500) {
        const firstKey = this.initCache.keys().next().value;
        if (firstKey) this.initCache.delete(firstKey);
      }
      this.initCache.set(filePath, out);

      return out;
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
   * Generates standard HLS Byte-Range playlist (RFC 8216) content.
   */
  buildM3u8Content(result: ParseResult, mediaUri: string, initUri?: string): string {
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

    const mapTag = initUri
      ? `#EXT-X-MAP:URI="${initUri}"`
      : `#EXT-X-MAP:URI="${mediaUri}",BYTERANGE="${initSize}@0"`;

    const lines: string[] = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      mapTag,
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
      if (content.length > 0) {
        let isValid = true;
        // Invalidate legacy sidecars that don't use the video-only init segment endpoint
        if (!content.includes("/api/videos/init")) {
          isValid = false;
        }

        try {
          const fileInfo = await Deno.stat(fullVideoPath);
          for (const line of content.split("\n")) {
            const match = line.match(/#EXT-X-BYTERANGE:(\d+)@(\d+)/) || line.match(/BYTERANGE="?(\d+)@(\d+)"?/);
            if (match) {
              const segLen = parseInt(match[1], 10);
              const segOff = parseInt(match[2], 10);
              if (segOff + segLen > fileInfo.size) {
                isValid = false;
                break;
              }
            }
          }
        } catch {
          isValid = false;
        }

        if (isValid) {
          return content;
        } else {
          console.warn(`Stale/legacy m3u8 sidecar detected for ${relVideoPath}, regenerating.`);
          try {
            await Deno.remove(sidecarPath);
          } catch {
            // ignore
          }
        }
      }
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
        const initUri = `/api/videos/init?path=${encodeURIComponent(relVideoPath)}`;
        const m3u8Content = this.buildM3u8Content(parseResult, mediaUri, initUri);

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
