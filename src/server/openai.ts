import type { OpenAIConfig } from './config.js';
import { OpenAIRequestError } from './openai-error.js';
import type { GeneratedJobCopy, JobCopySource } from '../shared/job-copy.js';
import { buildJobCopyFacts, JOB_COPY_INSTRUCTIONS } from './job-copy-prompt.js';

export interface JobCopyGenerator {
  generate(job: JobCopySource): Promise<GeneratedJobCopy>;
}

interface OpenAIResponse {
  status?: string;
  incomplete_details?: { reason?: string };
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
}

export class OpenAIJobCopyGenerator implements JobCopyGenerator {
  constructor(
    private readonly config: OpenAIConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async generate(job: JobCopySource): Promise<GeneratedJobCopy> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.config.apiBaseUrl}/responses`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          store: false,
          max_output_tokens: 1_600,
          ...(/^gpt-6(?:[.-]|$)/i.test(this.config.model) ? { reasoning: { effort: 'none' } } : {}),
          instructions: `${JOB_COPY_INSTRUCTIONS}\nReturn the result using the supplied JSON schema.`,
          input: buildJobCopyFacts(job),
          text: {
            format: {
              type: 'json_schema',
              name: 'service_job_copy',
              strict: true,
              schema: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'SEO title for the completed service job.' },
                  excerpt: { type: 'string', description: 'Short local-SEO job-card description.' },
                  body: {
                    type: 'object',
                    properties: {
                      intro: { type: 'string', description: 'Opening paragraph describing the documented customer need or job context.' },
                      contextHeading: { type: 'string', description: 'Question-style heading for the explanatory section.' },
                      contextParagraph: { type: 'string', description: 'Grounded explanation of why the documented issue or service matters.' },
                      workHeading: { type: 'string', description: 'Question-style heading for the documented service scope.' },
                      workItems: {
                        type: 'array',
                        minItems: 2,
                        maxItems: 4,
                        items: { type: 'string' },
                        description: 'Two to four concise, factual scope items without invented actions.',
                      },
                      closing: { type: 'string', description: 'Short outcome paragraph, qualified when no completed outcome is documented.' },
                    },
                    required: ['intro', 'contextHeading', 'contextParagraph', 'workHeading', 'workItems', 'closing'],
                    additionalProperties: false,
                  },
                },
                required: ['title', 'excerpt', 'body'],
                additionalProperties: false,
              },
            },
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new OpenAIRequestError('OpenAI copy generation timed out. Try again.', 504);
      }
      throw new OpenAIRequestError('OpenAI copy generation could not be reached. Try again.', 502);
    }

    if (!response.ok) throw await openAIError(response);

    let body: OpenAIResponse;
    try {
      body = await response.json() as OpenAIResponse;
    } catch {
      throw new OpenAIRequestError('OpenAI returned an invalid response.', 502);
    }

    const refusal = body.output
      ?.flatMap((item) => item.content || [])
      .find((content) => content.type === 'refusal')?.refusal;
    if (refusal) throw new OpenAIRequestError('OpenAI could not generate copy for this job.', 422);

    const outputText = body.output_text
      || body.output
        ?.flatMap((item) => item.content || [])
        .find((content) => content.type === 'output_text')?.text;
    if (!outputText) throw new OpenAIRequestError('OpenAI returned no generated copy.', 502);

    let parsed: unknown;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      if (body.status === 'incomplete') {
        throw new OpenAIRequestError('OpenAI did not finish generating the copy. Try again.', 502);
      }
      throw new OpenAIRequestError('OpenAI returned copy in an unexpected format.', 502);
    }
    return validateGeneratedCopy(parsed);
  }
}

export class DisabledJobCopyGenerator implements JobCopyGenerator {
  async generate(): Promise<GeneratedJobCopy> {
    throw new OpenAIRequestError('OpenAI copy generation is not configured on the server.', 503);
  }
}

const validateGeneratedCopy = (value: unknown): GeneratedJobCopy => {
  if (!value || typeof value !== 'object') {
    throw new OpenAIRequestError('OpenAI returned copy in an unexpected format.', 502);
  }
  const record = value as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.replace(/\s+/g, ' ').trim() : '';
  const excerpt = typeof record.excerpt === 'string' ? record.excerpt.replace(/\s+/g, ' ').trim() : '';
  const bodyRecord = record.body && typeof record.body === 'object'
    ? record.body as Record<string, unknown>
    : undefined;
  const body = bodyRecord ? {
    intro: normalizeText(bodyRecord.intro),
    contextHeading: normalizeText(bodyRecord.contextHeading),
    contextParagraph: normalizeText(bodyRecord.contextParagraph),
    workHeading: normalizeText(bodyRecord.workHeading),
    workItems: Array.isArray(bodyRecord.workItems) ? bodyRecord.workItems.map(normalizeText) : [],
    closing: normalizeText(bodyRecord.closing),
  } : undefined;
  if (title.length < 10 || title.length > 100 || excerpt.length < 20 || excerpt.length > 1_000) {
    throw new OpenAIRequestError('OpenAI generated copy outside the allowed length. Try again.', 502);
  }
  if (!body
    || !validBodyText(body.intro, 20, 1_500)
    || !validBodyText(body.contextHeading, 8, 140)
    || !validBodyText(body.contextParagraph, 20, 1_500)
    || !validBodyText(body.workHeading, 8, 140)
    || body.workItems.length < 2
    || body.workItems.length > 4
    || body.workItems.some((item) => !validBodyText(item, 5, 500))
    || !validBodyText(body.closing, 20, 1_500)) {
    throw new OpenAIRequestError('OpenAI generated incomplete project copy. Try again.', 502);
  }
  if ([title, excerpt, body.intro, body.contextHeading, body.contextParagraph, body.workHeading, ...body.workItems, body.closing]
    .some((text) => /<[^>]+>/.test(text))) {
    throw new OpenAIRequestError('OpenAI generated unsupported HTML. Try again.', 502);
  }
  return { title, excerpt, body };
};

const normalizeText = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

const validBodyText = (value: string, minimum: number, maximum: number): boolean =>
  value.length >= minimum && value.length <= maximum;

const openAIError = async (response: Response): Promise<OpenAIRequestError> => {
  if (response.status === 401 || response.status === 403) {
    return new OpenAIRequestError('OpenAI rejected the API credentials. Check OPENAI_API_KEY and project access.', 502);
  }
  if (response.status === 429) {
    return new OpenAIRequestError('OpenAI rate or spending limits were reached. Check the API project limits and try again.', 429);
  }
  if (response.status >= 500) {
    return new OpenAIRequestError('OpenAI is temporarily unavailable. Try again.', 502);
  }
  return new OpenAIRequestError('OpenAI could not generate copy with the configured model.', 502);
};
