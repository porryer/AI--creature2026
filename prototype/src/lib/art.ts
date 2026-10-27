// 程序化生成占位作品图（SVG data URI），用种子保证同一提示词得到同一张图，
// 原型不依赖任何外部图片资源。

type Palette = { name: string; colors: string[]; keywords: string[] };

const PALETTES: Palette[] = [
  { name: 'autumn', colors: ['#2b1408', '#8a3b12', '#d9792b', '#f2c46d', '#f7e7c4'], keywords: ['秋', '咖啡', '拿铁', '枫', '暖', '落日', '黄昏', '面包'] },
  { name: 'ocean', colors: ['#04121f', '#0b3b5c', '#1f7a99', '#62c2c9', '#d5f2ee'], keywords: ['海', '蓝', '冰', '雨', '水', '鲸', '夏'] },
  { name: 'neon', colors: ['#0b0420', '#3a0d6b', '#c2187d', '#16c5d9', '#f5e663'], keywords: ['赛博', '霓虹', '夜', '都市', '未来', '机甲', '电竞'] },
  { name: 'forest', colors: ['#06140d', '#1b4332', '#40916c', '#95d5b2', '#e9f5db'], keywords: ['森林', '绿', '茶', '山', '自然', '露营', '植物'] },
  { name: 'sakura', colors: ['#2a0f1c', '#7d2e4f', '#e07a9a', '#f6c1cf', '#fff1f3'], keywords: ['樱', '粉', '春', '花', '少女', '甜'] },
  { name: 'ink', colors: ['#0e0e0e', '#3b3b3b', '#8c8c86', '#d9d6cc', '#b8322a'], keywords: ['水墨', '国风', '古风', '书法', '武侠', '仙'] },
  { name: 'desert', colors: ['#1d1208', '#6b3e1e', '#c98b4a', '#e8c590', '#f4e8d0'], keywords: ['沙漠', '旅行', '复古', '胶片', '西部'] },
  { name: 'aurora', colors: ['#050b1a', '#13315c', '#3e7cb1', '#7ee0b5', '#e6f9a8'], keywords: ['极光', '星空', '宇宙', '梦', '奇幻'] },
  { name: 'citrus', colors: ['#1f1a05', '#7a5c00', '#f2a900', '#ffd65c', '#fff6d6'], keywords: ['柠檬', '橙', '活力', '饮料', '运动'] },
  { name: 'studio', colors: ['#121417', '#2f3540', '#6d7787', '#c9ced6', '#f3f4f6'], keywords: ['产品', '白底', '极简', '科技', '耳机', '手机'] },
];

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number) {
  let a = seed || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickPalette(text: string): Palette {
  const hit = PALETTES.find((p) => p.keywords.some((k) => text.includes(k)));
  return hit ?? PALETTES[hash(text) % PALETTES.length];
}

const cache = new Map<string, string>();

export interface ArtOptions {
  w?: number;
  h?: number;
  variant?: number;
}

/** 根据提示词生成一张抽象作品图。同一 (prompt, variant, 尺寸) 永远得到同一张图。 */
export function artFor(prompt: string, opts: ArtOptions = {}): string {
  const w = opts.w ?? 600;
  const h = opts.h ?? 800;
  const key = `${prompt}|${opts.variant ?? 0}|${w}x${h}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const pal = pickPalette(prompt);
  const r = rng(hash(key));
  const c = pal.colors;
  const pick = () => c[Math.floor(r() * c.length)];
  const id = `g${hash(key).toString(36)}`;

  const angle = Math.floor(r() * 360);
  const blobs: string[] = [];
  const blobCount = 3 + Math.floor(r() * 3);
  for (let i = 0; i < blobCount; i++) {
    const cx = (r() * w).toFixed(0);
    const cy = (r() * h).toFixed(0);
    const rad = (Math.min(w, h) * (0.25 + r() * 0.45)).toFixed(0);
    blobs.push(`<circle cx="${cx}" cy="${cy}" r="${rad}" fill="${pick()}" opacity="${(0.45 + r() * 0.45).toFixed(2)}"/>`);
  }

  // 地平线：用正弦叠加计算出的波形
  const layers: string[] = [];
  const layerCount = 1 + Math.floor(r() * 3);
  for (let l = 0; l < layerCount; l++) {
    const base = h * (0.55 + l * 0.12 + r() * 0.08);
    const amp = h * (0.03 + r() * 0.06);
    const freq = 1 + r() * 2.5;
    const phase = r() * Math.PI * 2;
    const pts: string[] = [];
    for (let x = 0; x <= w; x += w / 24) {
      const y = base + Math.sin((x / w) * Math.PI * freq + phase) * amp + Math.sin((x / w) * Math.PI * freq * 3.1) * amp * 0.25;
      pts.push(`${x.toFixed(0)},${y.toFixed(0)}`);
    }
    const color = c[Math.min(c.length - 1, l)];
    layers.push(`<polygon points="0,${h} ${pts.join(' ')} ${w},${h}" fill="${color}" opacity="${(0.75 + l * 0.08).toFixed(2)}"/>`);
  }

  const sun =
    r() > 0.35
      ? `<circle cx="${(w * (0.2 + r() * 0.6)).toFixed(0)}" cy="${(h * (0.18 + r() * 0.25)).toFixed(0)}" r="${(Math.min(w, h) * (0.08 + r() * 0.1)).toFixed(0)}" fill="${c[c.length - 1]}" opacity="0.9"/>`
      : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
<defs>
<linearGradient id="${id}b" gradientTransform="rotate(${angle} .5 .5)"><stop offset="0" stop-color="${c[0]}"/><stop offset="1" stop-color="${c[1]}"/></linearGradient>
<filter id="${id}f" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${(Math.min(w, h) * 0.09).toFixed(0)}"/></filter>
<filter id="${id}n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0.09 0"/></filter>
</defs>
<rect width="${w}" height="${h}" fill="url(#${id}b)"/>
<g filter="url(#${id}f)">${blobs.join('')}</g>
${sun}
${layers.join('')}
<rect width="${w}" height="${h}" filter="url(#${id}n)"/>
</svg>`;

  const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  cache.set(key, uri);
  return uri;
}

/** 由比例字符串换算缩略图尺寸 */
export function sizeForRatio(ratio: string, long = 800): { w: number; h: number } {
  const [a, b] = ratio.split(':').map(Number);
  if (!a || !b) return { w: long, h: long };
  return a >= b ? { w: long, h: Math.round((long * b) / a) } : { w: Math.round((long * a) / b), h: long };
}

/** 用于音频波形的伪随机条高 */
export function waveFor(seed: string, n = 48): number[] {
  const r = rng(hash(seed));
  return Array.from({ length: n }, (_, i) => 0.2 + 0.8 * Math.abs(Math.sin(i * 0.45 + r() * 2)) * (0.5 + r() * 0.5));
}

/** 简易二维码图案（仅视觉示意） */
export function qrPattern(seed: string, n = 25): boolean[][] {
  const r = rng(hash(seed));
  const grid = Array.from({ length: n }, () => Array.from({ length: n }, () => r() > 0.5));
  const finder = (ox: number, oy: number) => {
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 7; x++) {
        const edge = x === 0 || y === 0 || x === 6 || y === 6;
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        grid[oy + y][ox + x] = edge || core;
      }
  };
  finder(0, 0);
  finder(n - 7, 0);
  finder(0, n - 7);
  return grid;
}
