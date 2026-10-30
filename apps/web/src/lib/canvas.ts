// 画布与分享页共用的节点尺寸与类型样式

import { AudioLines, Image as ImageIcon, PenLine, Video } from 'lucide-react';
import type { Modality } from './types';

export const NODE_W = 248;
/** 连线端口距节点顶部的距离 */
export const PORT_Y = 24;
export const KIND_META: Record<Modality, { label: string; icon: typeof ImageIcon; color: string }> = {
  text: { label: '文本', icon: PenLine, color: 'var(--gold)' },
  image: { label: '图像生成', icon: ImageIcon, color: 'var(--accent)' },
  video: { label: '视频生成', icon: Video, color: 'var(--accent-2)' },
  audio: { label: '配音', icon: AudioLines, color: 'var(--violet)' },
};

/** 连线路径：从上游节点右侧端口到下游节点左侧端口的三次贝塞尔曲线 */
export function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const x1 = a.x + NODE_W;
  const y1 = a.y + PORT_Y;
  const x2 = b.x;
  const y2 = b.y + PORT_Y;
  const dx = Math.max(60, Math.abs(x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}
