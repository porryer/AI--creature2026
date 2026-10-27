// 套餐、积分包与赠送规则（对应 docs/02-prd.md 4.10 节）

export type PlanCode = 'free' | 'basic' | 'pro' | 'team';

export interface Plan {
  code: PlanCode;
  name: string;
  /** 价格，单位：分 */
  priceMonthFen: number;
  /** 年付折算的每月价格，单位：分 */
  priceYearPerMonthFen: number;
  monthlyCredits: number;
  /** 队列优先级：p0 最高 */
  queue: 'p0' | 'p1' | 'p2';
  perks: string[];
}

export const PLANS: Record<PlanCode, Plan> = {
  free: { code: 'free', name: '免费版', priceMonthFen: 0, priceYearPerMonthFen: 0, monthlyCredits: 0, queue: 'p2', perks: ['标准模型', '标准队列', '个人非商用', '作品保留 180 天'] },
  basic: { code: 'basic', name: '基础版', priceMonthFen: 3900, priceYearPerMonthFen: 2900, monthlyCredits: 600, queue: 'p1', perks: ['全部图像模型', '标准视频模型', '商用授权', '去除平台 Logo'] },
  pro: { code: 'pro', name: '专业版', priceMonthFen: 9900, priceYearPerMonthFen: 7900, monthlyCredits: 1800, queue: 'p0', perks: ['全部模型含旗舰', '优先队列', '4K 与原生音频', '角色库 · 品牌套件', 'Agent 无限会话'] },
  team: { code: 'team', name: '团队版', priceMonthFen: 29900, priceYearPerMonthFen: 24900, monthlyCredits: 6000, queue: 'p0', perks: ['含 3 个席位', '团队空间与权限', '共享资产与积分池', '评论审阅'] },
};

export const CREDIT_PACKS: { credits: number; priceFen: number }[] = [
  { credits: 100, priceFen: 1000 },
  { credits: 500, priceFen: 4500 },
  { credits: 2000, priceFen: 16000 },
];

export const GRANT_RULES = {
  signupCredits: 100,
  signupValidDays: 7,
  dailyCredits: 20,
  /** 积分包有效期（天） */
  packValidDays: 365,
  /** 订阅积分可结转一个周期 */
  subscriptionRolloverPeriods: 1,
};

/** 订单金额（分） */
export function orderAmountFen(itemType: 'subscription' | 'credit_pack', itemRef: string, cycle: 'month' | 'year' | null): { amountFen: number; credits: number } | null {
  if (itemType === 'credit_pack') {
    const pack = CREDIT_PACKS.find((p) => String(p.credits) === itemRef);
    return pack ? { amountFen: pack.priceFen, credits: pack.credits } : null;
  }
  const plan = PLANS[itemRef as PlanCode];
  if (!plan || plan.code === 'free' || !cycle) return null;
  return cycle === 'year' ? { amountFen: plan.priceYearPerMonthFen * 12, credits: plan.monthlyCredits } : { amountFen: plan.priceMonthFen, credits: plan.monthlyCredits };
}
