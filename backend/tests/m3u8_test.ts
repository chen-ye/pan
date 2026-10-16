import { assertEquals, assertNotEquals } from "@std/assert";
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
