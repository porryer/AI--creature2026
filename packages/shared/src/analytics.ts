// 数据埋点（docs/02-prd.md 第 6 节）：客户端可上报的事件与后台数据看板的数据结构

import type { Modality } from './types';

/** 客户端上报的界面行为；提交、成功 / 失败、下载 / 发布、支付、模板使用由服务端记录 */
export type ClientEvent =
  | { name: 'page_view'; props: { page: string } }
  | { name: 'paywall_shown'; props: { trigger: 'library' | 'insufficient_credits' | 'pricing' } }
  | { name: 'agent_plan_shown'; props: { step_count: number; estimated_credits: number } }
  | { name: 'agent_plan_confirmed'; props: { step_count: number; estimated_credits: number; edited_steps: number } }
  | { name: 'asset_export'; props: { channel: 'copy' | 'share'; asset_type: Modality; asset_id?: string } };

export const EVENT_LABEL: Record<string, string> = {
  page_view: '页面浏览',
  prompt_submit: '提交生成',
  task_succeeded: '生成成功',
  task_failed: '生成失败',
  asset_export: '导出 / 下载 / 发布',
  agent_plan_shown: '小造展示计划',
  agent_plan_confirmed: '小造计划确认执行',
  paywall_shown: '付费墙展示',
  order_paid: '支付成功',
  template_use: '使用模板',
};

export interface AdminAnalyticsDTO {
  days: number;
  /** 核心漏斗（去重用户数）；二次操作与导出按"生成成功"的用户计算 */
  funnel: { key: 'active' | 'submitted' | 'succeeded' | 'continued' | 'exported'; label: string; users: number }[];
  /** 北极星：每周被下载 / 导出 / 发布的成品数（按北京时间的周一起算），最近 8 周 */
  north_star: { week: string; works: number }[];
  events: { name: string; source: 'server' | 'client'; count: number }[];
  templates: { template_id: string; title: string; uses: number; users: number }[];
  paywall: { shown_users: number; paid_users: number; paid_orders: number; amount_fen: number };
}
