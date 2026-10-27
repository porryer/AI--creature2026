// 从文件头识别图片格式与尺寸（PNG / JPEG / WebP），不信任客户端声明的类型

export type RasterMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageInfo {
  mime: RasterMime;
  width: number;
  height: number;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// JPEG 帧头标记（SOF0–SOF15，排除 DHT/JPG/DAC）
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function imageInfo(buf: Buffer): ImageInfo | null {
  try {
    if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIG) && buf.toString('ascii', 12, 16) === 'IHDR') {
      return valid({ mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) return jpeg(buf);
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return webp(buf);
  } catch {
    return null;
  }
  return null;
}

function jpeg(buf: Buffer): ImageInfo | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    // 无长度字段的独立标记
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    if (SOF.has(marker)) return valid({ mime: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) });
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function webp(buf: Buffer): ImageInfo | null {
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return valid({ mime: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff });
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const b = buf.readUInt32LE(21);
    return valid({ mime: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 });
  }
  if (chunk === 'VP8X') return valid({ mime: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) });
  return null;
}

/** 拒绝 0 尺寸与超大尺寸（防止解码炸弹） */
function valid(i: ImageInfo): ImageInfo | null {
  return i.width > 0 && i.height > 0 && i.width <= 16384 && i.height <= 16384 ? i : null;
}
