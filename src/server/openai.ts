import type { OpenAIConfig } from './config.js';
import { OpenAIRequestError } from './openai-error.js';
import { isWordPressBodyHtml, type GeneratedJobCopy, type JobCopySource } from '../shared/job-copy.js';
import { buildJobCopyFacts, JOB_COPY_INSTRUCTIONS } from './job-copy-prompt.js';

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
          max_output_tokens: 2_000,
          ...(/^gpt-6(?:[.-]|$)/i.test(this.config.model) ? { reasoning: { effort: 'none' } } : {}),
          instructions: `${JOB_COPY_INSTRUCTIONS}\nReturn the result using the supplied JSON schema.`,
          input: buildJobCopyFacts(job),
          text: { format: {
            type: 'json_schema', name: 'recent_project_post', strict: true,
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Plain text post title.' },
                bodyHtml: { type: 'string', description: 'WordPress-ready HTML with 3–5 short p paragraphs and optional blockquote for an exact supplied review.' },
              },
              required: ['title', 'bodyHtml'], additionalProperties: false,
            },
          } },
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
    let parsed: unknown;
    try { parsed = JSON.parse(outputText); }
    catch {
      if (body.status === 'incomplete') throw new OpenAIRequestError('OpenAI did not finish generating the copy. Try again.', 502);
      throw new OpenAIRequestError('OpenAI returned copy in an unexpected format.', 502);
    }
    return validateGeneratedCopy(parsed);
  }
}

export class DisabledJobCopyGenerator implements JobCopyGenerator {
  async generate(): Promise<GeneratedJobCopy> { throw new OpenAIRequestError('OpenAI copy generation is not configured on the server.', 503); }
}

const validateGeneratedCopy = (value: unknown): GeneratedJobCopy => {
  if (!value || typeof value !== 'object') throw new OpenAIRequestError('OpenAI returned copy in an unexpected format.', 502);
  const record = value as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.replace(/\s+/g, ' ').trim() : '';
  const bodyHtml = typeof record.bodyHtml === 'string' ? record.bodyHtml.trim() : '';
  if (title.length < 5 || title.length > 160 || !isWordPressBodyHtml(bodyHtml)) {
    throw new OpenAIRequestError('OpenAI generated incomplete or invalid project copy. Try again.', 502);
  }
  if (/<(?:script|style|img|a|h[1-6]|ul|ol|li|div|span)\b|\son\w+\s*=|style\s*=|javascript:/i.test(bodyHtml)) {
    throw new OpenAIRequestError('OpenAI generated unsupported HTML. Try again.', 502);
  }
  return { title, bodyHtml };
};

const openAIError = async (response: Response): Promise<OpenAIRequestError> => {
  if (response.status === 401 || response.status === 403) return new OpenAIRequestError('OpenAI rejected the API credentials. Check OPENAI_API_KEY and project access.', 502);
  if (response.status === 429) return new OpenAIRequestError('OpenAI rate or spending limits were reached. Check the API project limits and try again.', 429);
  if (response.status >= 500) return new OpenAIRequestError('OpenAI is temporarily unavailable. Try again.', 502);
  return new OpenAIRequestError('OpenAI could not generate copy with the configured model.', 502);
};
