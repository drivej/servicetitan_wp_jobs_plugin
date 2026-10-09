export interface JobCopySource {
  jobName: string;
  summaryText?: string;
  technicianNotes?: string[];
  equipmentNames?: string[];
  imageFileNames?: string[];
  companyName?: string;
  customerReview?: string;
  location: { address?: string; city: string; state: string; zip: string };
}

export interface GeneratedJobCopy {
  title: string;
  bodyHtml: string;
}

export const formatJobCopy = ({ title, bodyHtml }: GeneratedJobCopy): string =>
  `TITLE: ${title.trim()}\nBODY:\n${bodyHtml.trim()}`;

export const hasCompleteJobBody = (copy: GeneratedJobCopy): boolean =>
  Boolean(copy.title.trim() && isWordPressBodyHtml(copy.bodyHtml));

export const hasFormattedJobBody = (value: string): boolean => {
  const match = value.trim().match(/^TITLE:\s*([^\n]+)\nBODY:\s*([\s\S]+)$/i);
  return Boolean(match && isWordPressBodyHtml(match[2]!.trim()));
};

export const isWordPressBodyHtml = (value: string): boolean => {
  if (value.length < 40 || value.length > 6_000 || /<(?!\/?(?:p|blockquote)\b)[^>]*>/i.test(value)) return false;
  const blocks = value.match(/<(p|blockquote)>([\s\S]*?)<\/\1>/gi) || [];
  const paragraphs = blocks.filter((block) => /^<p>/i.test(block));
  const quotes = blocks.filter((block) => /^<blockquote>/i.test(block));
  const residue = value.replace(/<(?:p|blockquote)>[\s\S]*?<\/(?:p|blockquote)>/gi, '').trim();
  return paragraphs.length >= 3 && paragraphs.length <= 5 && quotes.length <= 1 && residue === ''
    && blocks.every((block) => !/<[^>]+>/.test(block.slice(block.indexOf('>') + 1, block.lastIndexOf('<')))
      && block.slice(block.indexOf('>') + 1, block.lastIndexOf('<')).replace(/&(?:amp|lt|gt|quot|#39);/gi, 'x').trim().length > 0);
};
