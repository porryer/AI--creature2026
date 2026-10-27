// 写作类示例内容：前端离线模式与后端 Mock 供应商共用。
// 接入真实大模型后，这些内容只用于演示与测试。

export type WritingTemplate = 'xhs' | 'script' | 'ad' | 'article' | 'storyboard';
export type TransformKind = '改写' | '扩写' | '缩写' | '换语气';

export const STORYBOARD_SAMPLE: string[][] = [
  ['1', '远景', '雨夜街头，霓虹倒映在积水里，行人匆匆', '（环境音：雨声）', '3s'],
  ['2', '中景', '沈砚撑黑伞站在便利店门口，望向街对面', '—', '2s'],
  ['3', '特写', '女主回头，雨水顺着发梢滴落，眼神惊讶', '“……是你？”', '2s'],
  ['4', '近景', '沈砚握伞的手微微收紧', '“好久不见。”', '2s'],
  ['5', '全景', '两人隔着马路对望，一辆电车从中间驶过', '（电车铃声）', '3s'],
  ['6', '特写', '电车驶过后，街对面只剩一把打开的伞', '—', '3s'],
];

export function mockWriting(template: string | undefined, topic: string, tone = '亲切'): string {
  const t = topic.trim() || '秋季咖啡新品';
  switch (template) {
    case 'script':
      return `《${t}》15 秒口播脚本（${tone}）\n\n0–3 秒｜开场钩子\n画面：特写镜头，热气从杯口升起\n口播：“秋天的第一杯，你喝对了吗？”\n\n3–9 秒｜产品卖点\n画面：枫糖淋在奶泡上，慢动作\n口播：“真枫糖、燕麦奶、现磨豆，三样都不将就。”\n\n9–15 秒｜行动号召\n画面：门店外景 + 品牌 Logo\n口播：“到店说‘山野’，第二杯半价。”`;
    case 'ad':
      return `${t} · 广告文案（${tone}）\n\n主标题：把山野的秋天，装进一杯拿铁\n副标题：真枫糖 × 燕麦奶，限定 60 天\n\n卖点：\n· 加拿大真枫糖浆，不加香精\n· 燕麦奶基底，轻盈不腻\n· 每日现烘豆，下单现磨`;
    case 'article':
      return `${t}：一家小店如何在秋天被记住\n\n一、为什么是秋天\n秋天是饮品消费的拐点，热饮重新回到菜单 C 位……\n\n二、产品怎么讲故事\n比起“好喝”，用户更愿意为“有画面的味道”买单……\n\n三、门店如何承接流量\n从小红书种草到到店核销，关键是一个能被拍下来的角落……`;
    case 'storyboard':
      return STORYBOARD_SAMPLE.map((r) => r.join(' | ')).join('\n');
    case 'xhs':
    default:
      return `【标题】${t}｜这个秋天的第一杯，我先替你们试过了\n\n姐妹们，${t}真的有被惊艳到！\n\n入口是枫糖的焦香，接着是燕麦奶的绵密，最后留下一点点肉桂的暖意。店里靠窗的位置下午三点光线最好，随手一拍就是封面。\n\n推荐指数：★★★★★\n人均：32 元\n适合：一个人发呆 / 和闺蜜拍照\n\n#${t.replace(/\s/g, '')} #秋天的第一杯 #城市探店 #咖啡日记`;
  }
}

export function mockTransform(kind: TransformKind, text: string): string {
  switch (kind) {
    case '扩写':
      return `${text}在细节上再多说一点：它不只是一杯饮品，更像是给忙碌日子按下的暂停键。`;
    case '缩写':
      return text.slice(0, Math.max(6, Math.ceil(text.length / 2))) + '。';
    case '换语气':
      return `说真的，${text.replace(/！/g, '。')}`;
    case '改写':
    default:
      return text.replace(/真的/g, '确实').replace(/推荐/g, '强烈安利').replace(/惊艳/g, '眼前一亮');
  }
}

export const AI_TEXT_LABEL = '（本内容由 AI 生成）';

/** 去掉文本末尾的 AI 标识（编辑器内不重复显示，复制 / 导出时再统一附加） */
export function stripAiTextLabel(text: string): string {
  const t = text.trimEnd();
  return t.endsWith(AI_TEXT_LABEL) ? t.slice(0, -AI_TEXT_LABEL.length).trimEnd() : text;
}
