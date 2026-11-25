import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writePrivateFile } from '../../../utils/atomic-fs.js';
import type { WorkerPi } from './host.js';

const hardLimit = 8 * 1024 * 1024 - 64 * 1024; // Provider key renaming happens after this hook.
const softImageLimit = 4 * 1024 * 1024;
interface Block { type: string; imageUrl?: string; image_url?: string | { url: string }; text?: string }
interface Payload { messages: { content?: Block[] | string }[] }
const size = (payload: unknown) => Buffer.byteLength(JSON.stringify(payload));

export function prepareMistralRequest(payload: unknown, dir: string) {
  if (!Array.isArray((payload as Payload)?.messages)) throw Error('Unsupported native Mistral payload; request cancelled');
  const next = structuredClone(payload) as Payload;
  const images = [];
  for (const { content } of next.messages) {
    if (!Array.isArray(content)) continue;
    for (const [index, block] of content.entries()) {
      if (block?.type !== 'image_url') continue;
      const url = block.imageUrl ?? (typeof block.image_url === 'string' ? block.image_url : block.image_url?.url);
      const match = typeof url === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
      if (match) images.push({ content, index, format: match[1], data: match[2] });
    }
  }
  let body = size(next), imageBytes = images.reduce((n, image) => n + image.data.length, 0);
  // Never discard the newest image. If it alone exceeds the hard limit, abort rather than send.
  for (let i = 0; i < images.length - 1 && (body > hardLimit || imageBytes > softImageLimit || images.length - i > 20); i++) {
    const { content, index, format, data } = images[i];
    const binary = Buffer.from(data, 'base64'), hash = createHash('sha256').update(binary).digest('hex');
    const file = join(dir, 'mistral-images', `${hash}.${format === 'jpeg' ? 'jpg' : format}`);
    try { writePrivateFile(file, binary, { exclusive: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    body -= size(content[index]);
    content[index] = { type: 'text', text: `[Older screenshot omitted from this request to fit Mistral request limits. Saved image: ${JSON.stringify(file)}. Use an image-reading tool if needed. The original remains in session history.]` };
    body += size(content[index]);
    imageBytes -= data.length;
  }
  if (body > hardLimit) throw Error(`Mistral request body too large (${body} bytes); request cancelled before sending. Compact or reduce the latest tool output.`);
  return next;
}

export function mistralBudget(pi: WorkerPi, dir: string) {
  pi.on('before_provider_request', (event, ctx) => {
    if (ctx.model?.provider !== 'mistral' || ctx.model.api !== 'mistral-conversations') return;
    try { return prepareMistralRequest(event.payload, dir); }
    catch (error) { ctx.abort(); throw error; } // Pi logs hook exceptions but otherwise sends the original request.
  });
}
