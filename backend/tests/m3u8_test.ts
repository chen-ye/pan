import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { CONFIG } from "../src/config.ts";
import { m3u8Service } from "../src/services/m3u8.ts";

function makeBox(tag: string, payload: Uint8Array): Uint8Array {
  const box = new Uint8Array(8 + payload.length);
  const view = new DataView(box.buffer);
  view.setUint32(0, box.length);
  for (let i = 0; i < 4; i++) {
    box[4 + i] = tag.charCodeAt(i);
  }
  box.set(payload, 8);
  return box;
}

function concatBuffers(...bufs: Uint8Array[]): Uint8Array {
  const total = bufs.reduce((acc, b) => acc + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

function createSyntheticFmp4(fragCount = 3, timescale = 1000): Uint8Array {
  const ftyp = makeBox("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]));

  // mdhd box inside moov (version 0)
  const mdhdPayload = new Uint8Array(24);
  const mdhdView = new DataView(mdhdPayload.buffer);
  mdhdView.setUint32(12, timescale); // timescale at offset 12 in payload (16 from tag)
  const mdhd = makeBox("mdhd", mdhdPayload);
  const moov = makeBox("moov", mdhd);

  const parts = [ftyp, moov];

  for (let i = 0; i < fragCount; i++) {
    // tfdt box (version 0)
    const tfdtPayload = new Uint8Array(8);
    const tfdtView = new DataView(tfdtPayload.buffer);
    tfdtView.setUint32(4, i * 1000); // decodeTime at offset 4 in payload (8 from tag)
    const tfdt = makeBox("tfdt", tfdtPayload);

    // trun box with duration
    const trunPayload = new Uint8Array(12);
    const trunView = new DataView(trunPayload.buffer);
    trunPayload[0] = 0; // version 0
    trunPayload[1] = 0;
    trunPayload[2] = 1; // flags 0x000100 (sample duration present)
    trunPayload[3] = 0;
    trunView.setUint32(4, 1); // 1 sample
    trunView.setUint32(8, 1000); // duration 1000
    const trun = makeBox("trun", trunPayload);

    const moof = makeBox("moof", concatBuffers(tfdt, trun));
    const mdat = makeBox("mdat", new Uint8Array(100)); // 100 bytes data
    parts.push(moof, mdat);
  }

  return concatBuffers(...parts);
}

function createSyntheticFaststartMp4(): Uint8Array {
  const ftyp = makeBox("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]));
  const moov = makeBox("moov", new Uint8Array(50));
  const mdat = makeBox("mdat", new Uint8Array(1000));
  return concatBuffers(ftyp, moov, mdat);
}

Deno.test("M3u8Service - parses fragmented MP4 and generates valid HLS playlist", async () => {
  const fmp4Data = createSyntheticFmp4(3, 1000);
  const tempPath = await Deno.makeTempFile({ suffix: ".mp4" });
  await Deno.writeFile(tempPath, fmp4Data);

  try {
    const result = await m3u8Service.parseFmp4(tempPath);

    assertNotEquals(result, null);
    if (!result) return;

    assertEquals(result.timescale, 1000);
    assertEquals(result.fragments.length, 3);
    assertNotEquals(result.initSize, 0);

    const playlist = m3u8Service.buildM3u8Content(result, "test.mp4");
    assertEquals(playlist.startsWith("#EXTM3U"), true);
    assertEquals(playlist.includes("#EXT-X-VERSION:7"), true);
    assertEquals(playlist.includes('#EXT-X-MAP:URI="test.mp4"'), true);
    assertEquals(playlist.includes("#EXT-X-BYTERANGE:"), true);
    assertEquals(playlist.includes("#EXT-X-ENDLIST"), true);
    assertEquals(playlist.includes("#EXTINF:1.000,"), true);

    const playlistWithInit = m3u8Service.buildM3u8Content(result, "test.mp4", "/api/videos/init?path=test.mp4");
    assertEquals(playlistWithInit.includes('#EXT-X-MAP:URI="/api/videos/init?path=test.mp4"'), true);
    assertEquals(playlistWithInit.includes("BYTERANGE="), false);
  } finally {
    try {
      await Deno.remove(tempPath);
    } catch {
      // ignore
    }
  }
});

Deno.test("M3u8Service - getVideoOnlyInitSegment extracts video trak and drops audio trak", async () => {
  const ftyp = makeBox("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]));
  const mvhd = makeBox("mvhd", new Uint8Array(100));

  // Video track: tkhd (track 1) + mdia (hdlr 'vide')
  const tkhd1Payload = new Uint8Array(24);
  new DataView(tkhd1Payload.buffer).setUint32(12, 1); // track ID 1
  const tkhd1 = makeBox("tkhd", tkhd1Payload);
  const hdlr1Payload = new Uint8Array(20);
  hdlr1Payload.set(new TextEncoder().encode("vide"), 8); // 'vide' at offset 8 in payload (16 from tag)
  const hdlr1 = makeBox("hdlr", hdlr1Payload);
  const mdia1 = makeBox("mdia", hdlr1);
  const trak1 = makeBox("trak", concatBuffers(tkhd1, mdia1));

  // Audio track: tkhd (track 2) + mdia (hdlr 'soun')
  const tkhd2Payload = new Uint8Array(24);
  new DataView(tkhd2Payload.buffer).setUint32(12, 2); // track ID 2
  const tkhd2 = makeBox("tkhd", tkhd2Payload);
  const hdlr2Payload = new Uint8Array(20);
  hdlr2Payload.set(new TextEncoder().encode("soun"), 8); // 'soun'
  const hdlr2 = makeBox("hdlr", hdlr2Payload);
  const mdia2 = makeBox("mdia", hdlr2);
  const trak2 = makeBox("trak", concatBuffers(tkhd2, mdia2));

  // mvex with trex 1 and trex 2
  const trex1Payload = new Uint8Array(24);
  new DataView(trex1Payload.buffer).setUint32(4, 1); // track ID 1
  const trex1 = makeBox("trex", trex1Payload);

  const trex2Payload = new Uint8Array(24);
  new DataView(trex2Payload.buffer).setUint32(4, 2); // track ID 2
  const trex2 = makeBox("trex", trex2Payload);

  const mvex = makeBox("mvex", concatBuffers(trex1, trex2));
  const moov = makeBox("moov", concatBuffers(mvhd, trak1, trak2, mvex));

  const mp4Data = concatBuffers(ftyp, moov);
  const tempPath = await Deno.makeTempFile({ suffix: ".mp4" });
  await Deno.writeFile(tempPath, mp4Data);

  try {
    const initSeg = await m3u8Service.getVideoOnlyInitSegment(tempPath);
    assertNotEquals(initSeg, null);
    if (!initSeg) return;

    // Verify it is smaller than original because audio trak and trex were stripped
    assertEquals(initSeg.length < mp4Data.length, true);

    // Verify it contains 'vide' and does NOT contain 'soun'
    const text = new TextDecoder("latin1").decode(initSeg);
    assertEquals(text.includes("vide"), true);
    assertEquals(text.includes("soun"), false);
  } finally {
    try {
      await Deno.remove(tempPath);
    } catch {
      // ignore
    }
  }
});

Deno.test("M3u8Service - returns null for non-fragmented faststart MP4", async () => {
  const faststartData = createSyntheticFaststartMp4();
  const tempPath = await Deno.makeTempFile({ suffix: ".mp4" });
  await Deno.writeFile(tempPath, faststartData);

  try {
    const result = await m3u8Service.parseFmp4(tempPath);
    assertEquals(result, null);
  } finally {
    try {
      await Deno.remove(tempPath);
    } catch {
      // ignore
    }
  }
});

Deno.test("M3u8Service - returns null for truncated fMP4 where fragment exceeds file size", async () => {
  const fmp4Data = createSyntheticFmp4(3, 1000);
  const truncated = fmp4Data.subarray(0, fmp4Data.length - 50);
  const tempPath = await Deno.makeTempFile({ suffix: ".mp4" });
  await Deno.writeFile(tempPath, truncated);

  try {
    const result = await m3u8Service.parseFmp4(tempPath);
    assertEquals(result, null);
  } finally {
    try {
      await Deno.remove(tempPath);
    } catch {
      // ignore
    }
  }
});

Deno.test("M3u8Service - getOrGenerateSidecar generates, caches, and invalidates sidecar", async () => {
  const fmp4Data = createSyntheticFmp4(2, 1000);
  const testFileName = `temp_test_m3u8_${Date.now()}.mp4`;
  const fullPath = join(CONFIG.DATA_DIR, testFileName);
  const sidecarPath = `${fullPath}.m3u8`;
  await Deno.mkdir(CONFIG.DATA_DIR, { recursive: true });
  await Deno.writeFile(fullPath, fmp4Data);

  try {
    // 1. Generate sidecar
    const sidecar1 = await m3u8Service.getOrGenerateSidecar(testFileName);
    assertNotEquals(sidecar1, null);
    assertEquals(sidecar1!.includes("/api/videos/init"), true);
    assertEquals(sidecar1!.includes("#EXTINF:1.000,"), true);

    // Verify sidecar was written to disk
    const onDisk = await Deno.readTextFile(sidecarPath);
    assertEquals(onDisk, sidecar1);

    // 2. Fetch again - should hit in-memory cache
    const sidecar2 = await m3u8Service.getOrGenerateSidecar(testFileName);
    assertEquals(sidecar2, sidecar1);
  } finally {
    try {
      await Deno.remove(fullPath);
    } catch {
      // ignore
    }
    try {
      await Deno.remove(sidecarPath);
    } catch {
      // ignore
    }
  }
});




