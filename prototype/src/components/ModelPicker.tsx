import { Check, ChevronDown, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { modelsFor, routeModel, TIER_LABEL } from '../lib/models';
import type { Modality, ModelInfo, RoutingStrategy } from '../lib/types';
import { Segmented, Stars } from './ui';

interface Props {
  modality: Modality;
  prompt: string;
  strategy: RoutingStrategy;
  onStrategy: (s: RoutingStrategy) => void;
  pinned: string | null;
  onPinned: (code: string | null) => void;
}

/** 解析当前生效的模型：手动指定优先，否则走智能路由 */
export function useResolvedModel(modality: Modality, prompt: string, strategy: RoutingStrategy, pinned: string | null): { model: ModelInfo; reason: string; auto: boolean } {
  const pool = modelsFor(modality);
  const fixed = pinned ? pool.find((m) => m.code === pinned) : undefined;
  if (fixed) return { model: fixed, reason: `已手动指定 ${fixed.name}`, auto: false };
  return { ...routeModel(modality, prompt, strategy), auto: true };
}

export function ModelPicker({ modality, prompt, strategy, onStrategy, pinned, onPinned }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { model, reason, auto } = useResolvedModel(modality, prompt, strategy, pinned);
  const pool = modelsFor(modality);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const unit = modality === 'video' ? '/秒' : modality === 'image' ? '/张' : '';

  return (
    <div className="field">
      <div className="field-label">
        <span>模型</span>
        <span className="subtle" style={{ fontWeight: 400 }}>
          {pool.length} 个可用
        </span>
      </div>
      <div className="model-picker" ref={ref}>
        <button type="button" className="model-current" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {auto ? <Sparkles size={18} color="var(--accent)" /> : <span className={`tag ${modality}`}>{TIER_LABEL[model.tier]}</span>}
          <span className="grow">
            <span className="name">{auto ? `自动 · ${model.name}` : model.name}</span>
            <span className="sub" style={{ display: 'block' }}>
              {model.vendor} · {model.price} 积分{unit}起
            </span>
          </span>
          <ChevronDown size={16} />
        </button>
        {open && (
          <div className="model-menu" role="listbox" aria-label="选择模型">
            <button
              type="button"
              className="model-opt"
              role="option"
              aria-selected={auto}
              onClick={() => {
                onPinned(null);
                setOpen(false);
              }}
            >
              <Sparkles size={18} color="var(--accent)" />
              <span className="grow">
                <span className="row">
                  <b>自动选择</b>
                  <span className="tag ok">推荐</span>
                </span>
                <span className="desc" style={{ display: 'block' }}>
                  按提示词特征、质量、速度与成本自动匹配模型，主模型故障时自动切换
                </span>
              </span>
              {auto && <Check size={16} color="var(--accent)" />}
            </button>
            {pool.map((m) => (
              <button
                type="button"
                key={m.code}
                className="model-opt"
                role="option"
                aria-selected={!auto && m.code === model.code}
                onClick={() => {
                  onPinned(m.code);
                  setOpen(false);
                }}
              >
                <span className={`tag ${modality}`}>{TIER_LABEL[m.tier]}</span>
                <span className="grow">
                  <span className="row">
                    <b>{m.name}</b>
                    {m.tags.slice(0, 2).map((t) => (
                      <span className="tag" key={t}>
                        {t}
                      </span>
                    ))}
                  </span>
                  <span className="desc" style={{ display: 'block' }}>
                    {m.vendor} · {m.desc}
                  </span>
                  <span className="row" style={{ marginTop: 4, gap: 12 }}>
                    <span className="desc">
                      质量 <Stars n={m.quality} />
                    </span>
                    <span className="desc">
                      速度 <Stars n={m.speed} />
                    </span>
                  </span>
                </span>
                <span className="price">
                  {m.price}
                  {unit}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {auto && (
        <>
          <Segmented<RoutingStrategy>
            label="路由策略"
            value={strategy}
            onChange={onStrategy}
            options={[
              { value: 'auto', label: '智能推荐' },
              { value: 'cheap', label: '省积分' },
              { value: 'best', label: '最佳质量' },
            ]}
          />
          <div className="route-reason">
            <Sparkles size={14} />
            <span>{reason}</span>
          </div>
        </>
      )}
    </div>
  );
}
