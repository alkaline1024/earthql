export interface EarthQLBridge {
  platform: string;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    earthqlBridge: EarthQLBridge;
  }
}
