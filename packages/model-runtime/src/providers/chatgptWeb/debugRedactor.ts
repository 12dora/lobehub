/**
 * Redacting pass for the ChatGPT Web debug tee. The converted stream carries
 * whole base64 images and grounding URLs whose query strings are credentials —
 * neither belongs in a log line.
 */

export const createDebugRedactor = (): TransformStream<Uint8Array, Uint8Array> => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const redactFrame = (frame: string): string => {
    const dataIndex = frame.indexOf('data: ');
    if (dataIndex === -1) return frame;
    const head = frame.slice(0, dataIndex + 'data: '.length);
    const data = frame.slice(dataIndex + 'data: '.length);

    if (/^event: base64_image$/m.test(frame)) {
      const mime = /^"data:([^;]+);base64,/.exec(data)?.[1] ?? 'unknown';
      // the encoded length is a fine proxy; nothing is decoded to measure it
      return `${head}"<base64_image ${mime} ~${Math.floor((data.length * 3) / 4)} bytes>"`;
    }

    if (/^event: file$/m.test(frame)) {
      const mime = /"mimeType":"([^"]+)"/.exec(data)?.[1] ?? 'unknown';
      const size = /"size":(\d+)/.exec(data)?.[1] ?? '?';
      return `${head}"<file ${mime} ${size} bytes>"`;
    }

    return head + data.replaceAll(/(https?:\/\/[^"\s\\]+?)\?[^"\s\\]*/g, '$1?<redacted>');
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    flush(controller) {
      if (buffer) controller.enqueue(encoder.encode(redactFrame(buffer)));
    },
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        controller.enqueue(encoder.encode(`${redactFrame(buffer.slice(0, index))}\n\n`));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
    },
  });
};
