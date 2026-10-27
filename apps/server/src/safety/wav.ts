// 极简 PCM16 单声道 WAV 编解码，支持 LIST/INFO 元数据块（用于写入隐式标识）

export interface Wav {
  sampleRate: number;
  samples: Int16Array;
  info: Record<string, string>;
}

export function encodeWav(samples: Int16Array, sampleRate: number, info: Record<string, string> = {}): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // 单声道
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);

  const subs = Object.entries(info).map(([id, value]) => {
    const text = Buffer.from(`${value}\0`, 'utf8');
    const padded = text.length % 2 ? Buffer.concat([text, Buffer.alloc(1)]) : text;
    const head = Buffer.alloc(8);
    head.write(id.padEnd(4).slice(0, 4), 0, 'ascii');
    head.writeUInt32LE(text.length, 4);
    return Buffer.concat([head, padded]);
  });
  const list = subs.length
    ? (() => {
        const body = Buffer.concat([Buffer.from('INFO', 'ascii'), ...subs]);
        const head = Buffer.alloc(8);
        head.write('LIST', 0, 'ascii');
        head.writeUInt32LE(body.length, 4);
        return Buffer.concat([head, body]);
      })()
    : Buffer.alloc(0);

  const data = Buffer.alloc(8 + samples.length * 2);
  data.write('data', 0, 'ascii');
  data.writeUInt32LE(samples.length * 2, 4);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i], 8 + i * 2);

  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + fmt.length + list.length + data.length, 4);
  riff.write('WAVE', 8, 'ascii');
  return Buffer.concat([riff, fmt, list, data]);
}

export function decodeWav(buf: Buffer): Wav {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('不是 WAV 文件');
  let sampleRate = 0;
  let samples = new Int16Array(0);
  const info: Record<string, string> = {};
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === 'fmt ') {
      if (body.readUInt16LE(0) !== 1 || body.readUInt16LE(2) !== 1 || body.readUInt16LE(14) !== 16) throw new Error('只支持 PCM16 单声道');
      sampleRate = body.readUInt32LE(4);
    } else if (id === 'data') {
      samples = new Int16Array(size / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = body.readInt16LE(i * 2);
    } else if (id === 'LIST' && body.toString('ascii', 0, 4) === 'INFO') {
      let p = 4;
      while (p + 8 <= body.length) {
        const sid = body.toString('ascii', p, p + 4);
        const ssize = body.readUInt32LE(p + 4);
        info[sid] = body.toString('utf8', p + 8, p + 8 + ssize).replace(/\0+$/, '');
        p += 8 + ssize + (ssize % 2);
      }
    }
    off += 8 + size + (size % 2);
  }
  if (!sampleRate) throw new Error('WAV 缺少 fmt 块');
  return { sampleRate, samples, info };
}

/** 生成音调序列：notes 为频率（Hz），每个音 noteSec 秒，带简单包络 */
export function synth(notes: number[], noteSec: number, sampleRate: number, gap = 0): Int16Array {
  const per = Math.round(noteSec * sampleRate);
  const gapN = Math.round(gap * sampleRate);
  const out = new Int16Array(notes.length * (per + gapN));
  notes.forEach((f, n) => {
    const base = n * (per + gapN);
    for (let i = 0; i < per; i++) {
      const env = Math.min(1, i / (sampleRate * 0.01), (per - i) / (sampleRate * 0.03));
      out[base + i] = f > 0 ? Math.round(Math.sin((2 * Math.PI * f * i) / sampleRate) * 9000 * env) : 0;
    }
  });
  return out;
}
