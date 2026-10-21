declare module '@novnc/novnc' {
  export default class RFB {
    constructor(target: HTMLElement, urlOrChannel: string | object, options?: {
      credentials?: Record<string, unknown>;
      shared?: boolean;
      wsProtocols?: string[];
    });
    scaleViewport: boolean;
    clipViewport: boolean;
    viewOnly: boolean;
    disconnect(): void;
    addEventListener(type: string, listener: (event: { detail?: { clean?: boolean } }) => void): void;
    removeEventListener(type: string, listener: (event: { detail?: { clean?: boolean } }) => void): void;
  }
}
