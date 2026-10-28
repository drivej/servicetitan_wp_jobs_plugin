import type { OpenAIConfig } from './config.js';
import { InsufficientJobCopyError, OpenAIRequestError } from './openai-error.js';
import { isWordPressBodyHtml, type GeneratedJobCopy, type JobCopySource } from '../shared/job-copy.js';
import { buildJobCopyFacts, JOB_COPY_INSTRUCTIONS } from './job-copy-prompt.js';
import ipaddr from 'ipaddr.js';

export interface JobCopyGenerator { generate(job: JobCopySource): Promise<GeneratedJobCopy>; }
interface OpenAIResponse {
  status?: string;
  incomplete_details?: { reason?: string };
  output_text?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
}

export class OpenAIJobCopyGenerator implements JobCopyGenerator {
  constructor(private readonly config: OpenAIConfig, private readonly fetchImplementation: typeof fetch = fetch) {}

  async generate(job: JobCopySource): Promise<GeneratedJobCopy> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.config.apiBaseUrl}/responses`, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          store: false,
          max_output_tokens: 3_000,
          ...(/^gpt-6(?:[.-]|$)/i.test(this.config.model) ? { reasoning: { effort: 'none' } } : {}),
          instructions: JOB_COPY_INSTRUCTIONS,
          input: buildJobCopyFacts(job),
          ...(companyWebsiteDomain(job.companyWebsiteUrl) ? {
            tools: [{ type: 'web_search', search_context_size: 'low', filters: { allowed_domains: [companyWebsiteDomain(job.companyWebsiteUrl)!] } }],
          } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new OpenAIRequestError('OpenAI copy generation timed out. Try again.', 504);
      throw new OpenAIRequestError('OpenAI copy generation could not be reached. Try again.', 502);
    }
    if (!response.ok) throw await openAIError(response);
    let body: OpenAIResponse;
    try { body = await response.json() as OpenAIResponse; }
    catch { throw new OpenAIRequestError('OpenAI returned an invalid response.', 502); }
    const refusal = body.output?.flatMap((item) => item.content || []).find((content) => content.type === 'refusal')?.refusal;
    if (refusal) throw new OpenAIRequestError('OpenAI could not generate copy for this job.', 422);
    const outputText = body.output_text || body.output?.flatMap((item) => item.content || []).find((content) => content.type === 'output_text')?.text;
    if (!outputText) throw new OpenAIRequestError('OpenAI returned no generated copy.', 502);
    if (body.status === 'incomplete') throw new OpenAIRequestError('OpenAI did not finish generating the copy. Try again.', 502);
    if (outputText.trim() === 'try your best') throw new InsufficientJobCopyError();
    let parsed: unknown;
    try { parsed = JSON.parse(outputText); }
    catch {
      throw new OpenAIRequestError('OpenAI returned copy in an unexpected format.', 502);
    }
    return validateGeneratedCopy(parsed, job.imageFileNames || []);
  }
}

export class DisabledJobCopyGenerator implements JobCopyGenerator {
  async generate(): Promise<GeneratedJobCopy> { throw new OpenAIRequestError('OpenAI copy generation is not configured on the server.', 503); }
}

const validateGeneratedCopy = (value: unknown, imageFileNames: string[]): GeneratedJobCopy => {
  if (!value || typeof value !== 'object') throw new OpenAIRequestError('OpenAI returned copy in an unexpected format.', 502);
  const record = value as Record<string, unknown>;
  if (record.status !== 'ready' || !Array.isArray(record.image_alt_texts)
    || record.image_alt_texts.length !== imageFileNames.slice(0, 10).length
    || !record.image_alt_texts.every(text => typeof text === 'string' && text.length <= 2000)) {
    throw new OpenAIRequestError('OpenAI returned incomplete project metadata.', 502);
  }
  const title = typeof record.title === 'string' ? record.title.replace(/\s+/g, ' ').trim() : '';
  const bodyHtml = typeof record.body_html === 'string' ? record.body_html.trim() : '';
  const seoTitle = typeof record.seo_title === 'string' ? record.seo_title.replace(/\s+/g, ' ').trim() : '';
  const seoDescription = typeof record.meta_description === 'string' ? record.meta_description.replace(/\s+/g, ' ').trim() : '';
  if (title.length < 5 || title.length > 160 || seoTitle.length < 5 || seoTitle.length > 160
    || seoDescription.length < 40 || seoDescription.length > 320 || !isWordPressBodyHtml(bodyHtml)) {
    throw new OpenAIRequestError('OpenAI generated incomplete or invalid project copy. Try again.', 502);
  }
  if (/<(?:script|style|img|a|h[13456]|ul|ol|li|div|span)\b|\son\w+\s*=|style\s*=|javascript:/i.test(bodyHtml)) {
    throw new OpenAIRequestError('OpenAI generated unsupported HTML. Try again.', 502);
  }
  return { status: 'ready', title, bodyHtml, seoTitle, seoDescription, imageAltTexts: record.image_alt_texts as string[], imageFileNames: imageFileNames.slice(0, 10) };
};

const companyWebsiteDomain = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isIpAddress = ipaddr.isValid(hostname);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || isIpAddress || !hostname.includes('.') || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.test')) return undefined;
    return hostname;
  } catch { return undefined; }
};

const openAIError = async (response: Response): Promise<OpenAIRequestError> => {
  if (response.status === 401 || response.status === 403) return new OpenAIRequestError('OpenAI rejected the API credentials. Check OPENAI_API_KEY and project access.', 502);
  if (response.status === 429) return new OpenAIRequestError('OpenAI rate or spending limits were reached. Check the API project limits and try again.', 429);
  if (response.status >= 500) return new OpenAIRequestError('OpenAI is temporarily unavailable. Try again.', 502);
  return new OpenAIRequestError('OpenAI could not generate copy with the configured model.', 502);
};
