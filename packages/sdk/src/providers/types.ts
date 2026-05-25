import type { Provider } from '@obs/shared';

export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenerateRequest {
  model: string;
  messages: ProviderMessage[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GenerateResult {
  text: string;
  usage?: ProviderUsage;
  finishReason?: string;
}

export interface StreamChunk {
  textDelta: string;
  usage?: ProviderUsage;
  finishReason?: string;
}

export interface LLMProvider {
  readonly name: Provider;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  generateStream(req: GenerateRequest): AsyncIterable<StreamChunk>;
}
