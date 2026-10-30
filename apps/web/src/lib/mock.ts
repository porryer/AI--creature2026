// 原型示例数据。所有用户、作品、数值均为演示用途。
import type { Asset, LedgerEntry, Post } from './types';

const H = 3600_000;
const D = 24 * H;
export const NOW = Date.now();

export const POSTS: Post[] = [
  { id: 'p1', title: '秋日窗边的枫糖拿铁', prompt: '秋日午后的咖啡馆窗边，一杯枫糖拿铁，暖色逆光，胶片质感，浅景深', author: '林夏', kind: 'image', ratio: '3:4', likes: 2310, remix: 418, model: 'Seedream 4.0', tags: ['摄影', '美食'] },
  { id: 'p2', title: '赛博雨夜的便利店', prompt: '赛博朋克城市雨夜，霓虹灯下的便利店，倒影，电影感广角', author: '夜航船', kind: 'video', ratio: '16:9', likes: 1876, remix: 203, model: 'Seedance 2.5', tags: ['电影感', '城市'] },
  { id: 'p3', title: '水墨山居', prompt: '水墨国风，云雾缭绕的山间小屋，留白构图，朱砂印章', author: '砚山', kind: 'image', ratio: '3:4', likes: 3420, remix: 690, model: '通义万相 2.5', tags: ['国风', '插画'] },
  { id: 'p4', title: '极光下的露营车', prompt: '冰岛极光下的复古露营车，星空，长曝光，梦幻色调', author: 'Aurora', kind: 'image', ratio: '4:3', likes: 1588, remix: 172, model: 'Seedream 5.0', tags: ['旅行', '风景'] },
  { id: 'p5', title: '樱花电车 · 漫剧第 3 集', prompt: '动漫风格，春日樱花隧道中驶过的电车，少女望向窗外，日系清新', author: '阿杰工作室', kind: 'video', ratio: '9:16', likes: 4102, remix: 377, model: 'Vidu Q3', tags: ['动漫', '漫剧'] },
  { id: 'p6', title: '降噪耳机产品主图', prompt: '白色降噪耳机产品摄影，极简白底，柔和棚拍光，悬浮角度', author: '声域品牌', kind: 'image', ratio: '1:1', likes: 960, remix: 512, model: 'Seedream 4.0', tags: ['产品', '电商'] },
  { id: 'p7', title: '森林里的茶室', prompt: '晨雾森林中的日式茶室，绿植环绕，柔和自然光，宁静', author: '一叶', kind: 'image', ratio: '3:4', likes: 1210, remix: 98, model: '通义万相 2.5', tags: ['空间', '自然'] },
  { id: 'p8', title: '柠檬气泡水广告片', prompt: '柠檬气泡水产品广告片，切片柠檬落入杯中，气泡升腾，活力黄色，多镜头', author: '橙子创意', kind: 'video', ratio: '9:16', likes: 2205, remix: 340, model: 'Kling 3.0', tags: ['广告', '饮料'] },
  { id: 'p9', title: '海边的蓝色时刻', prompt: '夏日海边黄昏后的蓝色时刻，灯塔，海浪，宁静氛围', author: '潮汐', kind: 'image', ratio: '16:9', likes: 874, remix: 61, model: 'Seedream 4.0', tags: ['风景'] },
  { id: 'p10', title: '沙漠公路旅行', prompt: '复古胶片风格的沙漠公路，老式敞篷车，热浪，西部电影感', author: '公路诗人', kind: 'image', ratio: '4:3', likes: 1432, remix: 155, model: 'Seedream 5.0', tags: ['胶片', '旅行'] },
  { id: 'p11', title: '武侠竹林对决', prompt: '武侠古风，竹林中两位剑客对峙，落叶飞舞，环绕运镜', author: '砚山', kind: 'video', ratio: '16:9', likes: 2987, remix: 260, model: 'Seedance 2.5', tags: ['国风', '动作'] },
  { id: 'p12', title: '粉色少女房间', prompt: '粉色系少女房间，樱花窗景，毛绒玩具，柔光，3D 渲染风格', author: '糖霜', kind: 'image', ratio: '1:1', likes: 1650, remix: 288, model: '造物·极速', tags: ['3D', '可爱'] },
  { id: 'p13', title: '星空下的鲸', prompt: '奇幻插画，巨大的鲸鱼在星空中游过小镇上空，梦幻', author: 'Aurora', kind: 'image', ratio: '3:4', likes: 3891, remix: 702, model: '通义万相 2.5', tags: ['奇幻', '插画'] },
  { id: 'p14', title: '机甲少年', prompt: '未来都市中的机甲少年，霓虹光效，动漫风格，动态姿势', author: '夜航船', kind: 'image', ratio: '3:4', likes: 2140, remix: 330, model: 'Seedream 4.0', tags: ['动漫', '科幻'] },
  { id: 'p15', title: '面包店清晨', prompt: '清晨的法式面包店，刚出炉的可颂，暖色晨光，温馨', author: '林夏', kind: 'video', ratio: '9:16', likes: 1120, remix: 140, model: '万相 Wan 2.6', tags: ['美食', 'Vlog'] },
  { id: 'p16', title: '山野露营海报', prompt: '山野露营节海报，标题文字“山野计划”，绿色系，扁平插画', author: '一叶', kind: 'image', ratio: '3:4', likes: 990, remix: 451, model: 'Seedream 4.0', tags: ['海报', '设计'] },
];

/** 离线演示用的模板使用次数与评分（模板目录见 packages/shared/src/templates.ts；接入后端时为真实统计） */
export const MOCK_TEMPLATE_STATS: Record<string, { uses: number; rating: number }> = {
  t1: { uses: 48210, rating: 4.8 },
  'scene-swap': { uses: 36702, rating: 4.7 },
  t3: { uses: 12880, rating: 4.6 },
  t4: { uses: 9420, rating: 4.7 },
  'ink-avatar': { uses: 65230, rating: 4.9 },
  'festival-poster': { uses: 22140, rating: 4.6 },
  t7: { uses: 8730, rating: 4.5 },
  'logo-reveal': { uses: 5210, rating: 4.4 },
  t9: { uses: 6840, rating: 4.8 },
  t10: { uses: 3120, rating: 4.5 },
  'xhs-cover': { uses: 30410, rating: 4.7 },
  'xhs-note': { uses: 27650, rating: 4.6 },
};

export const PROJECTS = [
  { id: 'pr1', name: '山野咖啡 · 秋季上新', updated: NOW - 2 * H, members: ['周', '林', '阿'], items: 38, covers: ['秋日 咖啡 拿铁 枫', '秋 面包 暖', '秋 落日 咖啡'] },
  { id: 'pr2', name: '樱花电车 · 漫剧第 4 集', updated: NOW - 26 * H, members: ['杰', '沈', '宁', '小'], items: 126, covers: ['动漫 樱花 少女', '樱 春 电车', '夜 都市 动漫'] },
  { id: 'pr3', name: '声域耳机 · 双十一', updated: NOW - 3 * D, members: ['周', '许'], items: 52, covers: ['产品 白底 耳机', '科技 极简 产品', '霓虹 都市 夜'] },
  { id: 'pr4', name: '个人 · 小红书日更', updated: NOW - 5 * D, members: ['林'], items: 211, covers: ['樱 粉 少女', '森林 茶 绿', '海 蓝 夏'] },
  { id: 'pr5', name: '城市漫游播客', updated: NOW - 9 * D, members: ['潮', '林'], items: 17, covers: ['海 蓝 宁静', '复古 胶片 旅行', '星空 宇宙'] },
];

export const CHARACTERS = [
  { id: 'c1', name: '林夏', desc: '25 岁生活方式博主，短发、圆框眼镜、米色风衣', refs: 6, used: 214, seed: '暖 秋 人像 博主' },
  { id: 'c2', name: '阿橘', desc: '品牌 IP · 橘色胖猫，围着绿色围巾', refs: 5, used: 98, seed: '橙 活力 猫' },
  { id: 'c3', name: '沈砚', desc: '漫剧男主，黑发少年，白衬衫，冷静', refs: 8, used: 402, seed: '动漫 少年 夜' },
];

export const BRAND_KIT = {
  name: '山野咖啡',
  tone: '温暖、自然、有手作感；避免过度精致的商业感',
  colors: [
    { name: '焦糖', hex: '#B5652B' },
    { name: '燕麦', hex: '#EBDDC5' },
    { name: '松针', hex: '#2F5D46' },
    { name: '炭黑', hex: '#22201E' },
  ],
  fonts: ['思源宋体 · 标题', '思源黑体 · 正文'],
  banned: ['卡通化咖啡杯', '冷色调', '塑料质感'],
};

export const PLANS = [
  { code: 'free', name: '免费版', month: 0, year: 0, credits: '每日 20', perks: ['标准模型', '标准队列', '个人非商用', '作品保留 180 天'] },
  { code: 'basic', name: '基础版', month: 39, year: 29, credits: '600 / 月', perks: ['全部图像模型', '标准视频模型', '商用授权', '去除平台 Logo'] },
  { code: 'pro', name: '专业版', month: 99, year: 79, credits: '1800 / 月', perks: ['全部模型含旗舰', '优先队列', '4K 与原生音频', '角色库 · 品牌套件', 'Agent 无限会话'], featured: true },
  { code: 'team', name: '团队版', month: 299, year: 249, credits: '6000 / 月 · 共享', perks: ['含 3 个席位', '团队空间与权限', '共享资产与积分池', '评论审阅'] },
];

export const CREDIT_PACKS = [
  { credits: 100, price: 10 },
  { credits: 500, price: 45 },
  { credits: 2000, price: 160 },
];

export const WRITING_TEMPLATES = [
  { id: 'xhs', name: '小红书笔记', hint: '标题 + 正文 + 话题标签' },
  { id: 'script', name: '短视频脚本', hint: '口播 / 分段 / 时长' },
  { id: 'ad', name: '广告文案', hint: 'Slogan + 卖点' },
  { id: 'storyboard', name: '分镜表', hint: '镜号 · 景别 · 画面 · 台词' },
  { id: 'article', name: '公众号文章', hint: '长文结构' },
];

export const VOICES = [
  { id: 'v1', name: '晚晴', desc: '温柔女声 · 叙事', av: '晴' },
  { id: 'v2', name: '青川', desc: '沉稳男声 · 纪录片', av: '川' },
  { id: 'v3', name: '小满', desc: '元气少女 · 种草', av: '满' },
  { id: 'v4', name: '老陈', desc: '烟火气大叔 · 探店', av: '陈' },
  { id: 'v5', name: '星野', desc: '少年音 · 动漫', av: '星' },
  { id: 'v6', name: '知微', desc: '知性女声 · 播客', av: '微' },
];

export const INITIAL_ASSETS: Asset[] = [
  { id: 'a1', kind: 'image', title: '枫糖拿铁 · 主视觉', prompt: '秋日午后的咖啡馆窗边，一杯枫糖拿铁，暖色逆光，胶片质感', ratio: '3:4', variant: 0, createdAt: NOW - 2 * H, model: 'Seedream 4.0', favorite: true, folder: '山野咖啡' },
  { id: 'a2', kind: 'image', title: '枫糖拿铁 · 副图', prompt: '秋日午后的咖啡馆窗边，一杯枫糖拿铁，暖色逆光，胶片质感', ratio: '3:4', variant: 1, createdAt: NOW - 2 * H, model: 'Seedream 4.0', folder: '山野咖啡' },
  { id: 'a3', kind: 'video', title: '新品上市 · 10 秒', prompt: '秋日咖啡馆，镜头缓慢推进到冒着热气的拿铁，落叶飘过窗外', ratio: '9:16', variant: 0, createdAt: NOW - 3 * H, model: 'Kling 3.0', durationSec: 10, folder: '山野咖啡' },
  { id: 'a4', kind: 'image', title: '樱花电车 · 分镜 07', prompt: '动漫风格，春日樱花隧道中驶过的电车，少女望向窗外', ratio: '16:9', variant: 2, createdAt: NOW - 26 * H, model: 'Vidu Q3', folder: '漫剧第 4 集' },
  { id: 'a5', kind: 'audio', title: '旁白 · 晚晴', prompt: '这个秋天，把山野的温度装进一杯拿铁里。', ratio: '1:1', variant: 0, createdAt: NOW - 3 * H, model: '造物·配音', durationSec: 8, folder: '山野咖啡' },
  { id: 'a6', kind: 'image', title: '降噪耳机 · 场景图', prompt: '白色降噪耳机放在温暖的木质桌面上，绿植，自然窗光', ratio: '1:1', variant: 0, createdAt: NOW - 3 * D, model: 'Seedream 4.0', folder: '声域耳机' },
  { id: 'a7', kind: 'text', title: '秋季上新 · 小红书文案', prompt: '小红书笔记', ratio: '1:1', variant: 0, createdAt: NOW - 2 * H, model: '豆包 Pro', text: '这个秋天的第一杯，必须是枫糖拿铁……', folder: '山野咖啡' },
  { id: 'a8', kind: 'image', title: '水墨山居', prompt: '水墨国风，云雾缭绕的山间小屋，留白构图，朱砂印章', ratio: '3:4', variant: 0, createdAt: NOW - 4 * D, model: '通义万相 2.5', favorite: true },
  { id: 'a9', kind: 'video', title: '雨夜重逢 · 镜头 03', prompt: '动漫风格，雨夜街头，少年撑伞回头，霓虹倒影', ratio: '16:9', variant: 1, createdAt: NOW - 27 * H, model: 'Vidu Q3', durationSec: 5, folder: '漫剧第 4 集' },
  { id: 'a10', kind: 'image', title: '露营节海报', prompt: '山野露营节海报，标题文字“山野计划”，绿色系，扁平插画', ratio: '3:4', variant: 0, createdAt: NOW - 6 * D, model: 'Seedream 4.0' },
  { id: 'a11', kind: 'audio', title: '片头音乐 · Lo-fi', prompt: 'Lo-fi 爵士，温暖，咖啡馆氛围，30 秒', ratio: '1:1', variant: 1, createdAt: NOW - 5 * D, model: '造物·配乐', durationSec: 30 },
  { id: 'a12', kind: 'image', title: '星空下的鲸', prompt: '奇幻插画，巨大的鲸鱼在星空中游过小镇上空，梦幻', ratio: '3:4', variant: 0, createdAt: NOW - 8 * D, model: '通义万相 2.5' },
];

export const INITIAL_LEDGER: LedgerEntry[] = [
  { id: 'l7', time: NOW - 2 * H, type: 'settle', label: '图像生成 · Seedream 4.0 · 2K ×4', delta: -24, balance: 1268 },
  { id: 'l6', time: NOW - 3 * H, type: 'refund', label: '视频生成失败返还 · 供应商超时', delta: 80, balance: 1292 },
  { id: 'l5', time: NOW - 3 * H - 300_000, type: 'freeze', label: '视频生成冻结 · 海螺 Hailuo 2.3 · 10 秒', delta: -80, balance: 1212 },
  { id: 'l4', time: NOW - 4 * H, type: 'settle', label: '视频生成 · Kling 3.0 · 10 秒 1080p', delta: -300, balance: 1292 },
  { id: 'l3', time: NOW - 9 * H, type: 'grant', label: '每日登录赠送', delta: 20, balance: 1592 },
  { id: 'l2', time: NOW - 2 * D, type: 'settle', label: '画布运行 · 樱花电车分镜 ×12', delta: -228, balance: 1572 },
  { id: 'l1', time: NOW - 6 * D, type: 'grant', label: '专业版月度积分', delta: 1800, balance: 1800 },
];

/** 近 30 天每日消耗（图像 / 视频），示例数据 */
export const USAGE_30D = Array.from({ length: 30 }, (_, i) => {
  const img = Math.round(18 + 14 * Math.abs(Math.sin(i * 0.7)) + (i % 7 === 5 ? 20 : 0));
  const vid = i % 3 === 0 ? Math.round(40 + 60 * Math.abs(Math.cos(i))) : i % 5 === 0 ? 80 : 0;
  return { day: i, img, vid };
});

export const ADMIN = {
  kpis: [
    { k: '今日生成任务', v: '128,406', d: '+8.2%', up: true },
    { k: '生成成功率', v: '97.3%', d: '+0.4pt', up: true },
    { k: '今日收入', v: '¥186,240', d: '+12.6%', up: true },
    { k: '综合毛利率', v: '46.8%', d: '-1.1pt', up: false },
  ],
  models: [
    { code: 'seedream-4', name: 'Seedream 4.0', success: 99.1, p95: 14.2, share: 38, health: 'ok' },
    { code: 'wanx-2.5', name: '通义万相 2.5', success: 98.6, p95: 16.8, share: 17, health: 'ok' },
    { code: 'creature-swift', name: '造物·极速', success: 99.6, p95: 4.1, share: 21, health: 'ok' },
    { code: 'kling-3.0', name: 'Kling 3.0', success: 94.2, p95: 286, share: 9, health: 'warn' },
    { code: 'wan-2.6', name: '万相 Wan 2.6', success: 97.8, p95: 132, share: 8, health: 'ok' },
    { code: 'hailuo-2.3', name: '海螺 Hailuo 2.3', success: 81.5, p95: 410, share: 2, health: 'down' },
    { code: 'seedance-2.5', name: 'Seedance 2.5', success: 96.4, p95: 198, share: 5, health: 'ok' },
  ],
  moderation: [
    { id: 'm1', kind: 'image', prompt: '泳池边的人物写真，夏日阳光', label: '疑似低俗 · 0.62', user: 'u_8f21', seed: '海 蓝 夏' },
    { id: 'm2', kind: 'video', prompt: '城市街头追逐的动作场面', label: '疑似暴力 · 0.55', user: 'u_2c90', seed: '霓虹 都市 夜' },
    { id: 'm3', kind: 'image', prompt: '某知名演员同款造型海报', label: '公众人物肖像 · 0.71', user: 'u_77ab', seed: '复古 胶片' },
    { id: 'm4', kind: 'text', prompt: '保健品功效宣传文案', label: '广告法风险 · 0.58', user: 'u_c013', seed: '柠檬 活力' },
  ],
  trend: [62, 68, 71, 66, 74, 80, 92, 88, 85, 90, 97, 104, 99, 112, 118, 121, 116, 125, 128],
};

export function timeAgo(t: number): string {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return '刚刚';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

export function fmt(n: number): string {
  return n.toLocaleString('zh-CN');
}
