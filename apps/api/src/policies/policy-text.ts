import mammoth from 'mammoth';
import { extractText } from 'unpdf';

/**
 * Reads the text of a published policy (decision #89): PDF through unpdf (PDF.js), Word (.docx)
 * through mammoth. A scanned PDF has no text layer and comes back empty: Ask iPro then can't answer
 * from it, and the policy admin screen says so.
 */
export async function readPolicyText(body: Buffer, type: 'pdf' | 'docx'): Promise<string> {
  if (type === 'docx') {
    const result = await mammoth.extractRawText({ buffer: body });
    return result.value;
  }
  const { text } = await extractText(new Uint8Array(body), { mergePages: false });
  return text.join('\n\n');
}
