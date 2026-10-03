export interface JobCopySource {
  jobName: string;
  summaryText?: string;
  equipmentNames?: string[];
  location: {
    address?: string;
    city: string;
    state: string;
    zip: string;
  };
}

export interface GeneratedJobCopy {
  title: string;
  excerpt: string;
  body?: GeneratedJobBody;
}

export interface GeneratedJobBody {
  intro: string;
  contextHeading: string;
  contextParagraph: string;
  workHeading: string;
  workItems: string[];
  closing: string;
}

export const formatJobCopy = ({ title, excerpt, body }: GeneratedJobCopy): string => [
  `TITLE: ${title.trim()}`,
  `EXCERPT: ${excerpt.trim()}`,
  ...(body ? [
    `INTRO: ${body.intro.trim()}`,
    `CONTEXT HEADING: ${body.contextHeading.trim()}`,
    `CONTEXT: ${body.contextParagraph.trim()}`,
    `WORK HEADING: ${body.workHeading.trim()}`,
    'WORK ITEMS:',
    ...body.workItems.map((item) => `- ${item.trim()}`),
    `CLOSING: ${body.closing.trim()}`,
  ] : []),
].join('\n');

export const hasCompleteJobBody = (copy: GeneratedJobCopy): copy is GeneratedJobCopy & { body: GeneratedJobBody } =>
  Boolean(copy.body
    && copy.body.intro.trim()
    && copy.body.contextHeading.trim()
    && copy.body.contextParagraph.trim()
    && copy.body.workHeading.trim()
    && copy.body.workItems.length >= 2
    && copy.body.closing.trim());

export const hasFormattedJobBody = (value: string): boolean =>
  ['INTRO:', 'CONTEXT HEADING:', 'CONTEXT:', 'WORK HEADING:', 'WORK ITEMS:', 'CLOSING:']
    .every((label) => new RegExp(`(?:^|\\n)${label.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*\\S`, 'i').test(value))
  && (value.match(/^\s*-\s+\S.+$/gm)?.length || 0) >= 2;
