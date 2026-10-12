export interface JobCopySource {
  jobName: string;
  summaryText?: string;
  technicianNotes?: string[];
  equipmentNames?: string[];
  imageFileNames?: string[];
  companyName?: string;
  customerReview?: string;
  companyWebsiteUrl?: string;
  jobDetails?: Record<string, string | number | boolean | null | undefined>;
  userClarification?: string;
  location: { address?: string; city: string; state: string; zip: string };
}

export interface GeneratedJobCopy {
  title: string;
  bodyHtml: string;
  seoTitle: string;
  seoDescription: string;
}

export const formatJobCopy = ({ title, bodyHtml, seoTitle, seoDescription }: GeneratedJobCopy): string =>
  `TITLE: ${title.trim()}\nBODY:\n${bodyHtml.trim()}\nSEO TITLE: ${seoTitle.trim()}\nSEO DESCRIPTION: ${seoDescription.trim()}`;

export const hasCompleteJobBody = (copy: unknown): copy is GeneratedJobCopy => {
  if (!copy || typeof copy !== 'object') return false;
  const record = copy as Record<string, unknown>;
  return typeof record.title === 'string'
    && record.title.trim().length > 0
    && typeof record.bodyHtml === 'string'
    && isWordPressBodyHtml(record.bodyHtml)
    && typeof record.seoTitle === 'string'
    && record.seoTitle.trim().length >= 5
    && typeof record.seoDescription === 'string'
    && record.seoDescription.trim().length >= 40;
};

export const hasFormattedJobBody = (value: string): boolean => {
  if (typeof value !== 'string') return false;
  const match = value.trim().match(/^TITLE:\s*([^\n]+)\nBODY:\s*([\s\S]*?)\nSEO TITLE:\s*([^\n]+)\nSEO DESCRIPTION:\s*([\s\S]+)$/i);
  return Boolean(match && isWordPressBodyHtml(match[2]!.trim()));
};

export const isWordPressBodyHtml = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length < 40 || value.length > 6_000) return false;
  const tokens = [...value.matchAll(/<\/?[a-z][^>]*>/gi)];
  const residue = value.replace(/<\/?[a-z][^>]*>/gi, '');
  if (/[<>]/.test(residue)) return false;
  const stack: string[] = [];
  let paragraphs = 0;
  let headings = 0;
  let quotes = 0;
  let cursor = 0;
  for (const token of tokens) {
    const before = value.slice(cursor, token.index);
    if (stack.length === 0 && before.trim()) return false;
    cursor = token.index! + token[0].length;
    const match = token[0].match(/^<(\/)?(p|h2|strong|blockquote)>$/i);
    if (!match) return false;
    const [, closing, rawTag] = match;
    const tag = rawTag!.toLowerCase();
    if (!closing) {
      if (tag === 'p' || tag === 'h2' || tag === 'blockquote') {
        if (stack.length !== 0) return false;
        if (tag === 'p') paragraphs++;
        if (tag === 'h2') headings++;
        if (tag === 'blockquote') quotes++;
      } else if (stack.length !== 1 || !['p', 'h2', 'blockquote'].includes(stack[0]!)) return false;
      stack.push(tag);
    } else if (stack.pop() !== tag) return false;
  }
  if (stack.length !== 0 || value.slice(cursor).trim() || paragraphs < 1 || headings > 4 || quotes > 1) return false;
  return value.replace(/<[^>]+>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/gi, 'x').trim().length > 0;
};
