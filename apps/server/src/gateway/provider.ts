import type { GenerationParams, Modality, ModelInfo, Operation } from '@creature/shared';
import type { RawOutput } from '../safety/labeling.service';

/** 统一生成请求（docs/03-architecture.md 5.1） */
export interface AdapterRequest {
  taskId: string;
  model: ModelInfo;
  modality: Modality;
  operation: Operation;
  prompt: string;
  params: GenerationParams;
  /** 在候选模型列表中的序号，0 为主模型 */
  candidateIndex: number;
  signal: AbortSignal;
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
