/**
 * RFB 3.8 客户端消息过滤器：只读会话丢掉键鼠和剪贴板，其它请求（像素格式、编码、
 * 帧缓冲更新）原样转发。过滤在服务端强制执行，前端 viewOnly 只是体验。
 *
 * 消息类型（ClientInit 之后）：
 *   0 SetPixelFormat (20)
 *   2 SetEncodings (4 + 4*n)
 *   3 FramebufferUpdateRequest (10)
 *   4 KeyEvent (8)              ← 丢弃
 *   5 PointerEvent (6)          ← 丢弃
 *   6 ClientCutText (8 + len)   ← 丢弃
 */
const DROP = new Set([4, 5, 6]);

export class RfbViewOnlyFilter {
  private pending = Buffer.alloc(0);

  filter(chunk: Buffer): { forward: Buffer } | { error: string } {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    const out: Buffer[] = [];
    while (this.pending.length > 0) {
      const type = this.pending[0];
      const size = this.messageSize(this.pending);
      if (size === undefined) break;
      if (size < 0) return { error: 'invalid view-only RFB stream' };
      const message = this.pending.subarray(0, size);
      this.pending = this.pending.subarray(size);
      if (!DROP.has(type)) out.push(message);
    }
    return { forward: out.length === 0 ? Buffer.alloc(0) : out.length === 1 ? out[0] : Buffer.concat(out) };
  }

  private messageSize(buffer: Buffer): number | undefined {
    if (buffer.length < 1) return undefined;
    switch (buffer[0]) {
      case 0: return buffer.length >= 20 ? 20 : undefined;
      case 2: {
        if (buffer.length < 4) return undefined;
        const count = buffer.readUInt16BE(2);
        const size = 4 + count * 4;
        return count > 256 ? -1 : buffer.length >= size ? size : undefined;
      }
      case 3: return buffer.length >= 10 ? 10 : undefined;
      case 4: return buffer.length >= 8 ? 8 : undefined;
      case 5: return buffer.length >= 6 ? 6 : undefined;
      case 6: {
        if (buffer.length < 8) return undefined;
        const length = buffer.readUInt32BE(4);
        const size = 8 + length;
        return length > 1_048_576 ? -1 : buffer.length >= size ? size : undefined;
      }
      default:
        return -1;
    }
  }
}
