import { artSvg } from '../src/art';
import { composePrompt, contextSummary, type ContextSnapshot } from '../src/library';

const ctx: ContextSnapshot = {
  characters: [
    { id: 'chr_a', name: '林夏', description: '短发、圆框眼镜', ref_asset_ids: ['ast_1'] },
    { id: 'chr_b', name: '阿橘', description: '', ref_asset_ids: ['ast_2'] },
  ],
  brand_kit: {
    id: 'bk_1',
    name: '山野咖啡',
    tone: '温暖自然',
    colors: [{ name: '焦糖', hex: '#B5652B' }],
    fonts: ['思源宋体'],
    banned: ['冷色调'],
    logo_asset_id: 'ast_logo',
  },
  place_logo: true,
};

describe('角色与品牌套件注入', () => {
  it('没有引用时原样返回提示词', () => {
    expect(composePrompt('海报', 'image', null)).toBe('海报');
    expect(composePrompt('海报', 'image', { characters: [], brand_kit: null, place_logo: false })).toBe('海报');
  });

  it('图像：角色设定、标准色、字体、禁用元素与 Logo 位置（右下角留给 AI 标识）', () => {
    expect(composePrompt('窗边聊天', 'image', ctx)).toBe(
      '窗边聊天\n【角色】林夏：短发、圆框眼镜；阿橘（外观与对应的角色参考图保持一致）\n' +
        '【品牌规范】品牌「山野咖啡」；调性：温暖自然；主色调使用标准色 焦糖 #B5652B；画面中的文字使用 思源宋体；画面中不要出现：冷色调；在画面右上角放置品牌 Logo（见 Logo 参考图），不改变 Logo 的形状与颜色',
    );
  });

  it('写作只注入调性与禁用元素；视频不注入字体', () => {
    expect(composePrompt('新品文案', 'text', { ...ctx, characters: [], place_logo: false })).toBe('新品文案\n【品牌规范】品牌「山野咖啡」；调性：温暖自然；文中不要出现：冷色调');
    expect(composePrompt('短片', 'video', { ...ctx, place_logo: false })).not.toContain('思源宋体');
  });

  it('任务中只展示名称', () => {
    expect(contextSummary(ctx)).toEqual({ characters: [{ id: 'chr_a', name: '林夏' }, { id: 'chr_b', name: '阿橘' }], brand_kit: { id: 'bk_1', name: '山野咖啡' }, place_logo: true });
    expect(contextSummary(null)).toBeNull();
  });

  it('作图可以指定配色（品牌标准色），否则按提示词挑选', () => {
    const branded = artSvg('海报', { w: 100, h: 100, palette: ['#2F5D46', '#B5652B'] });
    expect(branded).toContain('#2F5D46');
    expect(branded).toContain('#B5652B');
    expect(artSvg('海报', { w: 100, h: 100 })).not.toContain('#2F5D46');
  });
});
