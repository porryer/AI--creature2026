/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** api：连接后端；mock（默认）：本地模拟数据的离线演示 */
  readonly VITE_BACKEND?: 'api' | 'mock';
}
