import { AudioLines, Bot, Image as ImageIcon, Maximize, Minus, PenLine, Play, Plus, Send, Trash2, Video, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Art } from '../components/Art';
import { Status } from '../components/ui';
import { TEMPLATES } from '../lib/mock';
import { estimateCredits, modelByCode, routeModel } from '../lib/models';
import { uid, useStore } from '../lib/store';
import type { Modality, Output, Task, TaskStatus } from '../lib/types';

type NodeStatus = 'draft' | 'waiting' | 'stale' | TaskStatus;

interface CNode {
  id: string;
  kind: Modality;
  title: string;
  prompt: string;
  x: number;
  y: number;
  modelCode: string;
  params: Task['params'];
  count: number;
  status: NodeStatus;
  taskId?: string;
  outputs?: Output[];
}

interface CEdge {
  id: string;
  from: string;
  to: string;
}

interface PlanStep {
  id: string;
  kind: Modality;
  title: string;
  prompt: string;
  modelCode: string;
  params: Task['params'];
  count: number;
  credits: number;
  dependsOn: string[];
  nodeId?: string;
}

interface Plan {
  id: string;
  title: string;
  steps: PlanStep[];
  state: 'proposed' | 'running' | 'done' | 'canceled';
  confirmArmed?: boolean;
}

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  plan?: Plan;
  typing?: boolean;
}

const NODE_W = 248;
const PORT_Y = 24;
const KIND_META: Record<Modality, { label: string; icon: typeof ImageIcon; color: string }> = {
  text: { label: '文本', icon: PenLine, color: 'var(--gold)' },
  image: { label: '图像生成', icon: ImageIcon, color: 'var(--accent)' },
  video: { label: '视频生成', icon: Video, color: 'var(--accent-2)' },
  audio: { label: '配音', icon: AudioLines, color: 'var(--violet)' },
};

const BASE_PROMPT = '山野咖啡秋季新品枫糖拿铁，暖色逆光，胶片质感，落叶';

function seedOutputs(id: string, kind: Modality, prompt: string, count: number, ratio: string, durationSec?: number): Output[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${id}_o${i}`, kind, prompt, ratio, variant: i, durationSec }));
}

const INITIAL_NODES: CNode[] = [
  { id: 'n1', kind: 'text', title: '海报文案与视频脚本', prompt: '主标题：把山野的秋天，装进一杯拿铁；副标题：真枫糖 × 燕麦奶，限定 60 天；15 秒脚本 3 个镜头', x: 40, y: 230, modelCode: 'qwen-max', params: { chars: 800 }, count: 1, status: 'succeeded', outputs: seedOutputs('n1', 'text', '主标题：把山野的秋天，装进一杯拿铁；副标题：真枫糖 × 燕麦奶，限定 60 天', 1, '1:1') },
  { id: 'n2', kind: 'image', title: '主视觉海报 ×3', prompt: `${BASE_PROMPT}，小红书竖版海报，标题文字“把山野的秋天装进一杯拿铁”`, x: 360, y: 30, modelCode: 'seedream-4', params: { ratio: '3:4', resolution: '2k', count: 3 }, count: 3, status: 'succeeded', outputs: seedOutputs('n2', 'image', `${BASE_PROMPT}，小红书竖版海报`, 3, '3:4') },
  { id: 'n3', kind: 'video', title: '15 秒产品短片', prompt: '镜头缓慢推进到冒着热气的枫糖拿铁，枫糖淋在奶泡上，窗外落叶飘过，多镜头', x: 690, y: 60, modelCode: 'wan-2.6', params: { ratio: '9:16', resolution: '1080p', duration: 15 }, count: 1, status: 'succeeded', outputs: seedOutputs('n3', 'video', `${BASE_PROMPT}，镜头推进`, 1, '9:16', 15) },
  { id: 'n4', kind: 'audio', title: '旁白配音 · 晚晴', prompt: '这个秋天，把山野的温度装进一杯拿铁里。', x: 360, y: 540, modelCode: 'creature-tts', params: { chars: 20, voice: '晚晴', seconds: 8 }, count: 1, status: 'succeeded', outputs: seedOutputs('n4', 'audio', '旁白', 1, '1:1', 8) },
];
const INITIAL_EDGES: CEdge[] = [
  { id: 'e1', from: 'n1', to: 'n2' },
  { id: 'e2', from: 'n1', to: 'n4' },
  { id: 'e3', from: 'n2', to: 'n3' },
  { id: 'e4', from: 'n1', to: 'n3' },
];

const INITIAL_MSGS: Msg[] = [
  { id: 'm0', role: 'user', text: '为山野咖啡做秋季上新物料：3 张小红书海报 + 1 条 15 秒抖音短视频，配上旁白' },
  {
    id: 'm1',
    role: 'assistant',
    text: '已读取品牌套件「山野咖啡」（焦糖 / 燕麦 / 松针配色，温暖手作感）。计划已执行完成：',
    plan: {
      id: 'p0',
      title: '秋季上新物料',
      state: 'done',
      steps: [
        { id: 's1', kind: 'text', title: '撰写海报文案与视频脚本', prompt: '', modelCode: 'qwen-max', params: {}, count: 1, credits: 1, dependsOn: [], nodeId: 'n1' },
        { id: 's2', kind: 'image', title: '主视觉海报 ×3 · 3:4 · 2K', prompt: '', modelCode: 'seedream-4', params: {}, count: 3, credits: 18, dependsOn: ['s1'], nodeId: 'n2' },
        { id: 's3', kind: 'video', title: '15 秒产品短片 · 1080p', prompt: '', modelCode: 'wan-2.6', params: {}, count: 1, credits: 240, dependsOn: ['s1', 's2'], nodeId: 'n3' },
        { id: 's4', kind: 'audio', title: '旁白配音 · 晚晴', prompt: '', modelCode: 'creature-tts', params: {}, count: 1, credits: 1, dependsOn: ['s1'], nodeId: 'n4' },
      ],
    },
  },
  { id: 'm2', role: 'assistant', text: '4 个节点全部完成，共消耗 260 积分。点选任一节点可以修改提示词后单独重跑，下游节点会标记为“已过期”。' },
];

/** 根据用户描述生成执行计划（原型用规则模拟规划模型的输出） */
function planFrom(text: string): Plan {
  const steps: PlanStep[] = [];
  const nineGrid = /九宫格/.test(text);
  const explicit = text.match(/(\d+)\s*张/);
  const imgCount = Math.min(9, explicit ? Number(explicit[1]) : nineGrid ? 9 : /海报|封面|配图/.test(text) ? 3 : 0);
  const wantVideo = /视频|短片|广告片|镜头/.test(text);
  const seconds = Math.min(15, Number(text.match(/(\d+)\s*秒/)?.[1] ?? 10));
  const wantAudio = /配音|旁白|口播|配乐/.test(text);
  const subject = text.replace(/^(为|帮我|给)/, '').slice(0, 30);

  const textModel = routeModel('text', text, 'auto').model;
  steps.push({ id: 's1', kind: 'text', title: '撰写文案与分镜脚本', prompt: `围绕「${subject}」撰写标题、卖点与分镜`, modelCode: textModel.code, params: { chars: 800 }, count: 1, credits: estimateCredits(textModel, { chars: 800 }), dependsOn: [] });
  if (imgCount > 0) {
    const prompt = `${subject}，${nineGrid || /朋友圈/.test(text) ? '1:1 方图' : '竖版海报'}，品牌色焦糖与燕麦，温暖自然光`;
    const m = routeModel('image', prompt + ' 海报', 'auto').model;
    const ratio = nineGrid || /朋友圈/.test(text) ? '1:1' : '3:4';
    const params = { ratio, resolution: '2k', count: imgCount };
    steps.push({ id: 's2', kind: 'image', title: `${nineGrid ? '九宫格配图' : '海报'} ×${imgCount} · ${ratio} · 2K`, prompt, modelCode: m.code, params, count: imgCount, credits: estimateCredits(m, params), dependsOn: ['s1'] });
  }
  if (wantVideo) {
    const prompt = `${subject}，竖版短视频，镜头推进，多镜头`;
    const m = routeModel('video', /广告|多镜头/.test(text) ? prompt : `${subject}，竖版短视频`, 'auto').model;
    const params = { ratio: '9:16', resolution: '1080p', duration: Math.min(seconds, m.maxDuration ?? 10) };
    steps.push({ id: 's3', kind: 'video', title: `${params.duration} 秒短片 · 9:16 · 1080p`, prompt, modelCode: m.code, params, count: 1, credits: estimateCredits(m, params), dependsOn: imgCount > 0 ? ['s1', 's2'] : ['s1'] });
  }
  if (wantAudio) {
    const m = modelByCode('creature-tts');
    steps.push({ id: 's4', kind: 'audio', title: '旁白配音 · 晚晴', prompt: '这个季节，让我们慢下来，喝一杯好咖啡。', modelCode: m.code, params: { chars: 60, voice: '晚晴', seconds: 10 }, count: 1, credits: 1, dependsOn: ['s1'] });
  }
  if (steps.length === 1) {
    const prompt = `${subject}，主视觉`;
    const m = routeModel('image', prompt, 'auto').model;
    const params = { ratio: '3:4', resolution: '2k', count: 4 };
    steps.push({ id: 's2', kind: 'image', title: '主视觉 ×4 · 3:4 · 2K', prompt, modelCode: m.code, params, count: 4, credits: estimateCredits(m, params), dependsOn: ['s1'] });
  }
  return { id: uid('pl'), title: subject || '新的创作计划', steps, state: 'proposed' };
}

/** 预估节点渲染高度，用于自动排布时避免重叠 */
function nodeHeight(kind: Modality, count: number, ratio: string): number {
  const [a, b] = ratio.split(':').map(Number);
  const r = a && b ? b / a : 1;
  if (kind === 'text') return 150;
  if (kind === 'audio') return 230;
  if (kind === 'video') return 170 + 224 * r;
  const n = Math.min(count, 4);
  return 170 + (n === 1 ? 224 * r : Math.ceil(n / 2) * 109 * r);
}

function templateNodes(templateId: string): { nodes: CNode[]; edges: CEdge[]; title: string } | null {
  const t = TEMPLATES.find((x) => x.id === templateId);
  if (!t) return null;
  const nodes: CNode[] = [];
  const cols: string[][] = [];
  let col = -1;
  let y = 0;
  t.steps.forEach((s, i) => {
    if (i === 0 || s.kind !== t.steps[i - 1].kind) {
      col++;
      y = 60;
      cols[col] = [];
    }
    const model = s.kind === 'audio' && s.title.includes('音乐') ? modelByCode('creature-music') : routeModel(s.kind, `${t.prompt} ${s.title}`, 'auto').model;
    const count = Number(s.title.match(/×(\d+)/)?.[1] ?? 1);
    // 视频步骤 ×N 展开为 N 个镜头节点，其余步骤一个节点
    const copies = s.kind === 'video' ? count : 1;
    for (let k = 0; k < copies; k++) {
      const params: Task['params'] =
        s.kind === 'image'
          ? { ratio: t.ratio, resolution: '2k', count }
          : s.kind === 'video'
            ? { ratio: t.ratio, resolution: '1080p', duration: 5 }
            : s.kind === 'audio'
              ? { chars: s.credits * 300, voice: '晚晴', seconds: model.code === 'creature-music' ? 30 : 10 }
              : { chars: 800 };
      const id = uid('n');
      const title = copies > 1 ? `镜头 ${k + 1} · 5 秒` : s.title;
      nodes.push({ id, kind: s.kind, title, prompt: `${t.prompt}：${title}`, x: 40 + col * 320, y, modelCode: model.code, params, count: s.kind === 'image' ? count : 1, status: 'draft' });
      cols[col].push(id);
      y += nodeHeight(s.kind, s.kind === 'image' ? count : 1, s.kind === 'audio' ? '3:1' : t.ratio) + 40;
    }
  });
  const edges: CEdge[] = cols.slice(1).flatMap((ids, c) => ids.flatMap((to) => cols[c].map((from) => ({ id: uid('e'), from, to }))));
  return { nodes, edges, title: t.title };
}

export function Canvas() {
  const { state, submit, setHandoff, toast } = useStore();
  const [nodes, setNodes] = useState<CNode[]>(INITIAL_NODES);
  const [edges, setEdges] = useState<CEdge[]>(INITIAL_EDGES);
  const [title, setTitle] = useState('山野咖啡 · 秋季上新');
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ x: 40, y: 90, k: 0.9 });
  const [msgs, setMsgs] = useState<Msg[]>(INITIAL_MSGS);
  const [input, setInput] = useState('');
  const [agentOpen, setAgentOpen] = useState(false);
  const [panning, setPanning] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ type: 'pan' | 'node'; id?: string; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // 同步任务状态到节点
  const taskMap = useMemo(() => new Map(state.tasks.map((t) => [t.id, t])), [state.tasks]);
  const liveNodes = useMemo(
    () =>
      nodes.map((n) => {
        const t = n.taskId ? taskMap.get(n.taskId) : undefined;
        if (!t) return { ...n, progress: 0 };
        return { ...n, status: t.status as NodeStatus, outputs: t.status === 'succeeded' ? t.outputs : n.outputs, progress: t.progress };
      }),
    [nodes, taskMap],
  );
  const byId = useMemo(() => new Map(liveNodes.map((n) => [n.id, n])), [liveNodes]);

  // 调度：等待中的节点在所有上游完成后提交
  useEffect(() => {
    for (const n of liveNodes) {
      if (n.status !== 'waiting') continue;
      const ups = edges.filter((e) => e.to === n.id).map((e) => byId.get(e.from));
      if (ups.some((u) => u && (u.status === 'waiting' || u.status === 'queued' || u.status === 'running'))) continue;
      const model = modelByCode(n.modelCode);
      const id = submit({ modality: n.kind, prompt: n.prompt, model, params: n.params, count: n.count, source: 'canvas' });
      setNodes((ns) => ns.map((x) => (x.id === n.id ? { ...x, taskId: id ?? undefined, status: id ? 'queued' : 'draft' } : x)));
    }
  }, [liveNodes, edges, byId, submit]);

  // 计划执行完成后汇报
  useEffect(() => {
    setMsgs((ms) => {
      let changed = false;
      const next = ms.map((m) => {
        if (!m.plan || m.plan.state !== 'running') return m;
        const ss = m.plan.steps.map((s) => byId.get(s.nodeId ?? ''));
        if (ss.every((n) => n && (n.status === 'succeeded' || n.status === 'failed' || n.status === 'blocked'))) {
          changed = true;
          return { ...m, plan: { ...m.plan, state: 'done' as const } };
        }
        return m;
      });
      if (!changed) return ms;
      const done = next.filter((m) => m.plan?.state === 'done').at(-1)?.plan;
      const total = done?.steps.reduce((a, s) => a + s.credits, 0) ?? 0;
      const failed = done?.steps.filter((s) => byId.get(s.nodeId ?? '')?.status !== 'succeeded').length ?? 0;
      const video = done?.steps.find((s) => s.kind === 'video');
      const vSec = Number(video?.params.duration ?? 0);
      const tip = video && vSec > 5 ? `短片缩短到 5 秒可节省约 ${Math.round((video.credits * (vSec - 5)) / vSec)} 积分。` : '可以把满意的结果拖到资产库的品牌文件夹里，方便团队复用。';
      return [
        ...next,
        {
          id: uid('m'),
          role: 'assistant',
          text: failed
            ? `计划执行结束，${failed} 个节点未成功，相关积分已返还。可以选中失败的节点调整后重跑。`
            : `全部 ${done?.steps.length} 个节点已完成，共消耗 ${total} 积分。建议：海报可以再生成一版冷暖对比色做 A/B 测试；${tip}`,
        },
      ];
    });
  }, [byId]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs]);

  const send = useCallback(
    (text: string) => {
      const value = text.trim();
      if (!value) return;
      const typingId = uid('m');
      setMsgs((ms) => [...ms, { id: uid('m'), role: 'user', text: value }, { id: typingId, role: 'assistant', typing: true }]);
      setInput('');
      window.setTimeout(() => {
        const plan = planFrom(value);
        const total = plan.steps.reduce((a, s) => a + s.credits, 0);
        setMsgs((ms) =>
          ms.map((m) =>
            m.id === typingId
              ? { id: typingId, role: 'assistant', text: `收到。我读取了品牌套件「山野咖啡」和画布上已有的节点，拆成 ${plan.steps.length} 个步骤，预计 ${total} 积分。你可以删掉不需要的步骤，确认后我再开始生成：`, plan }
              : m,
          ),
        );
      }, 1300);
    },
    [],
  );

  // 消费首页 / 模板带来的任务
  const consumed = useRef(false);
  useEffect(() => {
    const h = state.handoff;
    if (consumed.current || !h || h.to !== 'canvas') return;
    consumed.current = true;
    setHandoff(null);
    if (h.templateId) {
      const r = templateNodes(h.templateId);
      if (r) {
        setNodes(r.nodes);
        setEdges(r.edges);
        setTitle(r.title);
        setView({ x: 40, y: 90, k: 0.85 });
        const total = r.nodes.reduce((a, n) => a + estimateCredits(modelByCode(n.modelCode), n.params), 0);
        setMsgs([{ id: uid('m'), role: 'assistant', text: `已载入模板「${r.title}」，共 ${r.nodes.length} 个节点，全部运行预计 ${total} 积分。可以先修改节点提示词，再点击上方“运行全部”。` }]);
      }
    }
    if (h.agentPrompt) {
      setNodes([]);
      setEdges([]);
      setTitle('未命名画布');
      setMsgs([]);
      setAgentOpen(true);
      send(h.agentPrompt);
    }
  }, [state.handoff, setHandoff, send]);

  const removeStep = (planId: string, stepId: string) =>
    setMsgs((ms) =>
      ms.map((m) =>
        m.plan?.id === planId
          ? { ...m, plan: { ...m.plan, confirmArmed: false, steps: m.plan.steps.filter((s) => s.id !== stepId).map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== stepId) })) } }
          : m,
      ),
    );

  const confirmPlan = (plan: Plan) => {
    const total = plan.steps.reduce((a, s) => a + s.credits, 0);
    if (total > state.available) {
      toast(`积分不足：计划需要 ${total} 积分，当前可用 ${state.available}`, 'err');
      return;
    }
    if (total > 300 && !plan.confirmArmed) {
      setMsgs((ms) => ms.map((m) => (m.plan?.id === plan.id ? { ...m, plan: { ...m.plan, confirmArmed: true } } : m)));
      return;
    }
    const baseX = nodesRef.current.length ? Math.max(...nodesRef.current.map((n) => n.x)) + 340 : 40;
    const col: Record<Modality, number> = { text: 0, image: 1, audio: 1, video: 2 };
    const colY: Record<number, number> = {};
    const idMap: Record<string, string> = {};
    const newNodes: CNode[] = plan.steps.map((s) => {
      const id = uid('n');
      idMap[s.id] = id;
      const c = col[s.kind];
      const y = colY[c] ?? 40;
      colY[c] = y + nodeHeight(s.kind, s.count, s.kind === 'audio' ? '3:1' : String(s.params.ratio ?? '1:1')) + 40;
      return { id, kind: s.kind, title: s.title, prompt: s.prompt, x: baseX + c * 320, y, modelCode: s.modelCode, params: s.params, count: s.count, status: 'waiting' };
    });
    const newEdges: CEdge[] = plan.steps.flatMap((s) => s.dependsOn.filter((d) => idMap[d]).map((d) => ({ id: uid('e'), from: idMap[d], to: idMap[s.id] })));
    setNodes((ns) => [...ns, ...newNodes]);
    setEdges((es) => [...es, ...newEdges]);
    setMsgs((ms) => ms.map((m) => (m.plan?.id === plan.id ? { ...m, plan: { ...m.plan, state: 'running', steps: m.plan.steps.map((s) => ({ ...s, nodeId: idMap[s.id] })) } } : m)));
    if (stage.current) {
      const w = stage.current.clientWidth;
      setView({ x: Math.min(40, w - (baseX + 960) * 0.7), y: 70, k: 0.7 });
    }
  };

  const cancelPlan = (plan: Plan) => setMsgs((ms) => [...ms.map((m) => (m.plan?.id === plan.id ? { ...m, plan: { ...m.plan, state: 'canceled' as const } } : m)), { id: uid('m'), role: 'assistant', text: '已取消这个计划，没有消耗积分。' }]);

  // 画布交互
  const onStageDown = (e: RPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.node, .canvas-toolbar, .canvas-zoom, .canvas-title')) return;
    setSelected(null);
    drag.current = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    setPanning(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onNodeDown = (e: RPointerEvent, n: CNode) => {
    e.stopPropagation();
    setSelected(n.id);
    drag.current = { type: 'node', id: n.id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y };
    stage.current?.setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.type === 'pan') setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
    else setNodes((ns) => ns.map((n) => (n.id === d.id ? { ...n, x: d.ox + dx / view.k, y: d.oy + dy / view.k } : n)));
  };
  const onUp = () => {
    drag.current = null;
    setPanning(false);
  };
  const zoomAt = (factor: number, cx?: number, cy?: number) => {
    const rect = stage.current?.getBoundingClientRect();
    const px = cx ?? (rect ? rect.width / 2 : 0);
    const py = cy ?? (rect ? rect.height / 2 : 0);
    setView((v) => {
      const k = Math.min(2, Math.max(0.3, v.k * factor));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  };
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.08 : 1 / 1.08, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const fit = () => {
    const el = stage.current;
    if (!el || liveNodes.length === 0) return;
    const minX = Math.min(...liveNodes.map((n) => n.x));
    const minY = Math.min(...liveNodes.map((n) => n.y));
    const maxX = Math.max(...liveNodes.map((n) => n.x + NODE_W));
    const maxY = Math.max(...liveNodes.map((n) => n.y + 330));
    const k = Math.min(1.2, Math.max(0.3, Math.min((el.clientWidth - 80) / (maxX - minX), (el.clientHeight - 140) / (maxY - minY))));
    setView({ k, x: 40 - minX * k, y: 80 - minY * k });
  };

  // 窄屏首次进入时自动适应画布
  useEffect(() => {
    if ((stage.current?.clientWidth ?? 1000) < 700) fit();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        setNodes((ns) => ns.filter((n) => n.id !== selected));
        setEdges((es) => es.filter((x) => x.from !== selected && x.to !== selected));
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  const addNode = (kind: Modality) => {
    const el = stage.current;
    const cx = el ? (el.clientWidth / 2 - view.x) / view.k - NODE_W / 2 : 200;
    const cy = el ? (el.clientHeight / 2 - view.y) / view.k - 100 : 200;
    const defaults: Record<Modality, Pick<CNode, 'modelCode' | 'params' | 'count' | 'prompt'>> = {
      text: { modelCode: 'qwen-max', params: { chars: 800 }, count: 1, prompt: '写一段产品卖点文案' },
      image: { modelCode: 'seedream-4', params: { ratio: '3:4', resolution: '2k', count: 2 }, count: 2, prompt: '描述画面……' },
      video: { modelCode: 'wan-2.6', params: { ratio: '9:16', resolution: '720p', duration: 5 }, count: 1, prompt: '描述镜头……' },
      audio: { modelCode: 'creature-tts', params: { chars: 40, voice: '晚晴', seconds: 8 }, count: 1, prompt: '输入配音文字' },
    };
    const id = uid('n');
    const n: CNode = { id, kind, title: KIND_META[kind].label, x: cx, y: cy, status: 'draft', ...defaults[kind] };
    setNodes((ns) => [...ns, n]);
    if (selected) setEdges((es) => [...es, { id: uid('e'), from: selected, to: id }]);
    setSelected(id);
  };

  const downstream = (id: string, acc = new Set<string>()): Set<string> => {
    edges.filter((e) => e.from === id).forEach((e) => {
      if (!acc.has(e.to)) {
        acc.add(e.to);
        downstream(e.to, acc);
      }
    });
    return acc;
  };

  const editNode = (id: string, prompt: string) => {
    const down = downstream(id);
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id === id) return { ...n, prompt, taskId: undefined, status: 'draft', outputs: byId.get(id)?.outputs };
        if (down.has(n.id) && byId.get(n.id)?.status === 'succeeded') return { ...n, taskId: undefined, status: 'stale', outputs: byId.get(n.id)?.outputs };
        return n;
      }),
    );
  };

  const runIds = (ids: string[]) => {
    const targets = new Set(ids);
    const cost = liveNodes.filter((n) => targets.has(n.id)).reduce((a, n) => a + estimateCredits(modelByCode(n.modelCode), n.params), 0);
    if (cost > state.available) {
      toast(`积分不足：需要 ${cost} 积分，当前可用 ${state.available}`, 'err');
      return;
    }
    setNodes((ns) => ns.map((n) => (targets.has(n.id) ? { ...n, status: 'waiting', taskId: undefined } : n)));
  };

  const pending = liveNodes.filter((n) => n.status === 'draft' || n.status === 'stale' || n.status === 'failed');
  const pendingCost = pending.reduce((a, n) => a + estimateCredits(modelByCode(n.modelCode), n.params), 0);
  const sel = selected ? byId.get(selected) : undefined;

  return (
    <div className="canvas-wrap">
      <div
        ref={stage}
        className={`canvas-stage ${panning ? 'panning' : ''}`}
        style={{ backgroundSize: `${22 * view.k}px ${22 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
        onPointerDown={onStageDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        aria-label="画布"
      >
        <div className="canvas-toolbar" role="toolbar" aria-label="画布工具">
          {(Object.keys(KIND_META) as Modality[]).map((k) => {
            const M = KIND_META[k];
            return (
              <button key={k} className="btn ghost sm" onClick={() => addNode(k)} title={`添加${M.label}节点${selected ? '（自动连接到选中节点）' : ''}`}>
                <Plus size={13} />
                <M.icon size={14} color={M.color} />
                <span className="hide-sm">{M.label}</span>
              </button>
            );
          })}
          <span className="sep" />
          <button className="btn ghost sm" disabled={!sel} onClick={() => sel && runIds([sel.id])}>
            <Play size={14} /> 运行选中
          </button>
          <button className="btn primary sm" disabled={pending.length === 0} onClick={() => runIds(pending.map((n) => n.id))}>
            <Play size={14} /> 运行全部 <span className="cost">· {pendingCost} 积分</span>
          </button>
          <button className="btn ghost sm agent-toggle" onClick={() => setAgentOpen(true)}>
            <Bot size={14} /> 小造
          </button>
        </div>
        <div className="canvas-title">
          <b>{title}</b>
          <span className="subtle">· {liveNodes.length} 个节点 · 自动保存</span>
        </div>

        <div className="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="canvas-edges" width="1" height="1">
            {edges.map((e) => {
              const a = byId.get(e.from);
              const b = byId.get(e.to);
              if (!a || !b) return null;
              const x1 = a.x + NODE_W;
              const y1 = a.y + PORT_Y;
              const x2 = b.x;
              const y2 = b.y + PORT_Y;
              const dx = Math.max(60, Math.abs(x2 - x1) / 2);
              const flowing = b.status === 'running' || b.status === 'queued' || b.status === 'waiting';
              return <path key={e.id} className={flowing ? 'flow' : ''} d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`} stroke={KIND_META[a.kind].color} opacity={0.75} />;
            })}
          </svg>
          {liveNodes.map((n) => {
            const M = KIND_META[n.kind];
            const model = modelByCode(n.modelCode);
            const credits = estimateCredits(model, n.params);
            const isSel = selected === n.id;
            const outs = n.outputs ?? [];
            return (
              <div
                key={n.id}
                className={`node ${n.kind} ${isSel ? 'selected' : ''} ${n.status === 'running' ? 'running' : ''}`}
                style={{ left: n.x, top: n.y }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setSelected(n.id);
                }}
              >
                <span className="port in" />
                <span className="port out" />
                <div className="node-head" onPointerDown={(e) => onNodeDown(e, n)}>
                  <span className="ico">
                    <M.icon size={14} />
                  </span>
                  <span className="title">{n.title}</span>
                  <Status value={n.status === 'waiting' ? 'queued' : n.status} />
                </div>
                <div className="node-body">
                  {isSel ? (
                    <textarea
                      className="textarea"
                      style={{ minHeight: 76, fontSize: 12.5 }}
                      aria-label="节点提示词"
                      value={n.prompt}
                      onChange={(e) => editNode(n.id, e.target.value)}
                      onPointerDown={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <p className="prompt">{n.prompt}</p>
                  )}
                  {(n.status === 'running' || n.status === 'queued' || n.status === 'waiting') && (
                    <div className="progress">
                      <i style={{ width: `${n.status === 'running' ? n.progress : 3}%` }} />
                    </div>
                  )}
                  {outs.length > 0 && n.kind !== 'text' && (
                    <div className={`node-outs ${outs.length === 1 ? 'single' : ''}`} style={{ opacity: n.status === 'stale' ? 0.55 : 1 }}>
                      {outs.slice(0, 4).map((o) => (
                        <Art key={o.id} prompt={o.prompt} ratio={n.kind === 'audio' ? '3:1' : o.ratio} variant={o.variant} kind={o.kind} durationSec={o.durationSec} controls={o.kind === 'video'} long={320} />
                      ))}
                    </div>
                  )}
                  <div className="node-foot">
                    <span>{model.name}</span>
                    <span className="mono">{credits} 积分</span>
                  </div>
                  {isSel && (
                    <div style={{ display: 'flex', gap: 6 }} onPointerDown={(e) => e.stopPropagation()}>
                      <button className="btn primary sm" style={{ flex: 1 }} onClick={() => runIds([n.id])} disabled={n.status === 'running' || n.status === 'queued'}>
                        <Play size={13} /> 运行
                      </button>
                      <button
                        className="btn sm danger"
                        aria-label="删除节点"
                        onClick={() => {
                          setNodes((ns) => ns.filter((x) => x.id !== n.id));
                          setEdges((es) => es.filter((x) => x.from !== n.id && x.to !== n.id));
                          setSelected(null);
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {liveNodes.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
            <div className="empty" style={{ background: 'var(--surface)', maxWidth: 360, pointerEvents: 'auto' }}>
              <Bot size={28} />
              <b>画布是空的</b>
              <span>告诉右侧的小造你要做什么，或从工具条添加节点</span>
            </div>
          </div>
        )}

        <div className="canvas-zoom">
          <button className="icon-btn" style={{ width: 30, height: 30 }} aria-label="缩小" onClick={() => zoomAt(1 / 1.2)}>
            <Minus size={15} />
          </button>
          <span>{Math.round(view.k * 100)}%</span>
          <button className="icon-btn" style={{ width: 30, height: 30 }} aria-label="放大" onClick={() => zoomAt(1.2)}>
            <Plus size={15} />
          </button>
          <button className="icon-btn" style={{ width: 30, height: 30 }} aria-label="适应画布" onClick={fit}>
            <Maximize size={14} />
          </button>
        </div>
      </div>

      <aside className={`agent ${agentOpen ? 'open' : ''}`} aria-label="创作 Agent 小造">
        <div className="agent-head">
          <span className="mark">造</span>
          <div className="grow">
            <b>小造</b>
            <small>先给计划和积分预估，确认后才执行</small>
          </div>
          <button className="icon-btn agent-close" aria-label="收起小造" onClick={() => setAgentOpen(false)}>
            <X size={18} />
          </button>
        </div>
        <div className="agent-log" ref={logRef} aria-live="polite">
          {msgs.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="msg user">
                {m.text}
              </div>
            ) : (
              <div key={m.id} className="msg assistant">
                <div className="who">小造</div>
                {m.typing ? (
                  <span className="typing" aria-label="正在规划">
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  <p>{m.text}</p>
                )}
                {m.plan && <PlanCard plan={m.plan} byId={byId} onRemove={removeStep} onConfirm={confirmPlan} onCancel={cancelPlan} />}
              </div>
            ),
          )}
        </div>
        <div className="agent-input">
          <div className="agent-quick">
            {['再做一组朋友圈九宫格', '生成一条 10 秒抖音短片并配旁白', '做 4 张冷色调海报做 A/B 测试'].map((q) => (
              <button key={q} className="chip" onClick={() => send(q)}>
                {q}
              </button>
            ))}
          </div>
          <div className="box">
            <label htmlFor="agent-input" className="visually-hidden">
              给小造发消息
            </label>
            <textarea
              id="agent-input"
              rows={2}
              placeholder="描述你要做的内容，例如：3 张海报 + 10 秒短视频"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
            />
            <button className="btn primary sm" aria-label="发送" onClick={() => send(input)} disabled={!input.trim()}>
              <Send size={14} />
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function PlanCard({
  plan,
  byId,
  onRemove,
  onConfirm,
  onCancel,
}: {
  plan: Plan;
  byId: Map<string, CNode & { progress?: number }>;
  onRemove: (planId: string, stepId: string) => void;
  onConfirm: (p: Plan) => void;
  onCancel: (p: Plan) => void;
}) {
  const total = plan.steps.reduce((a, s) => a + s.credits, 0);
  const secs = Math.round(plan.steps.reduce((a, s) => a + (s.kind === 'video' ? 120 : s.kind === 'image' ? 15 : 6), 0) / 1.6);
  const stateText = { proposed: '待确认', running: '执行中', done: '已完成', canceled: '已取消' }[plan.state];
  return (
    <div className="plan">
      <div className="plan-head">
        <span>执行计划 · {plan.title}</span>
        <span className={`tag ${plan.state === 'done' ? 'ok' : plan.state === 'running' ? 'video' : plan.state === 'canceled' ? '' : 'text'}`}>{stateText}</span>
      </div>
      {plan.steps.map((s, i) => {
        const node = s.nodeId ? byId.get(s.nodeId) : undefined;
        const done = plan.state === 'done' || node?.status === 'succeeded';
        const active = node && (node.status === 'running' || node.status === 'queued');
        const M = KIND_META[s.kind];
        return (
          <div key={s.id} className={`plan-step ${done ? 'done' : active ? 'active' : ''}`}>
            <span className="n">{i + 1}</span>
            <div className="grow">
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <M.icon size={13} color={M.color} /> {s.title}
              </span>
              <small>
                {modelByCode(s.modelCode).name}
                {active && node?.status === 'running' ? ` · ${node.progress ?? 0}%` : active ? ' · 排队中' : ''}
              </small>
            </div>
            <span className="mono">{s.credits}</span>
            {plan.state === 'proposed' && plan.steps.length > 1 && (
              <button className="x" aria-label={`删除步骤 ${s.title}`} onClick={() => onRemove(plan.id, s.id)}>
                <X size={14} />
              </button>
            )}
          </div>
        );
      })}
      <div className="plan-foot">
        <span className="total">
          合计 <b>{total}</b> 积分 · 约 {secs < 60 ? `${secs} 秒` : `${Math.ceil(secs / 60)} 分钟`}
        </span>
        {plan.state === 'proposed' && (
          <span style={{ display: 'flex', gap: 6 }}>
            <button className="btn ghost sm" onClick={() => onCancel(plan)}>
              取消
            </button>
            <button className="btn primary sm" onClick={() => onConfirm(plan)}>
              {plan.confirmArmed ? '再次确认执行' : '确认执行'}
            </button>
          </span>
        )}
      </div>
      {plan.state === 'proposed' && plan.confirmArmed && (
        <div className="inline-confirm" style={{ margin: 10 }}>
          本次预计超过 300 积分，请再次点击确认。可以删掉不需要的步骤来降低消耗。
        </div>
      )}
    </div>
  );
}
