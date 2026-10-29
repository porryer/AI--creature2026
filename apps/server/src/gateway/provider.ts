import type { GenerationParams, Modality, ModelInfo, Operation, ReferenceRole } from '@creature/shared';
import type { RawOutput } from '../safety/labeling.service';

/** 统一生成请求（docs/03-architecture.md 5.1） */
export interface AdapterRequest {
  taskId: string;
  model: ModelInfo;
  modality: Modality;
  operation: Operation;
  prompt: string;
  params: GenerationParams;
  /** 参考图（已读取的文件内容） */
  references: ReferenceInput[];
  /** 品牌标准色（提示词中已包含；支持调色板参数的模型可直接使用） */
  palette?: string[];
  /** 在候选模型列表中的序号，0 为主模型 */
  candidateIndex: number;
  signal: AbortSignal;
}

export interface ReferenceInput {
  /** mask：局部重绘 / 消除的涂抹区域（白色为要修改的部分）；logo：品牌 Logo，需原样放进画面 */
  role: ReferenceRole | 'mask' | 'logo';
  /** 同一角色的多张参考图共用一个分组（角色 ID） */
  group?: string;
  mime: string;
  data: Buffer;
  width?: number;
  height?: number;
}

export interface AdapterResult {
  outputs: RawOutput[];
  /** 平台成本（分），用于毛利分析 */
  vendorCostFen: number;
}

/** 供应商适配器：每家供应商一个实现，网关只依赖这个接口 */
export interface ProviderAdapter {
  readonly name: string;
  supports(model: ModelInfo): boolean;
  generate(req: AdapterRequest, onProgress: (pct: number) => void): Promise<AdapterResult>;
}

/** 供应商错误：retryable 为 true 时网关会切换备选模型 */
export class VendorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export const PROVIDER_ADAPTERS = Symbol('PROVIDER_ADAPTERS');
