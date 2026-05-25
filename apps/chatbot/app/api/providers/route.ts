import {
  availableProviders,
  defaultSelectableProvider,
  providerConfig,
  providerModels,
  unreachableProviders,
} from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// `reachable: false` flags providers wired but unreachable here (e.g. Ollama on the hosted demo) so the UI can disable send.
export async function GET(): Promise<Response> {
  const unreachable = new Set(unreachableProviders());
  const providers = availableProviders().map((id) => ({
    id,
    model: providerConfig(id).model,
    models: providerModels(id),
    reachable: !unreachable.has(id),
  }));
  return Response.json({
    providers,
    default: defaultSelectableProvider(),
  });
}
