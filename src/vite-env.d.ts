/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __APP_IS_OFFICIAL__: boolean;

interface ImportMetaEnv {
  readonly VITE_LOTUS_E2E?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  __LOTUS_E2E__?: import('./e2eBridge').LotusE2eBridge;
}
