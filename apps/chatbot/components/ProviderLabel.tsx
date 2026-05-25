import { PROVIDER_ICONS, formatProvider } from '@/lib/providers-ui';

// Renders the provider icon in a fixed-width slot so the name column lines up
// across rows regardless of icon width (emoji vs. glyph). Use this anywhere a
// vertical list of providers is shown; plain-string contexts (title="...",
// <option> labels in native <select>) should keep using formatProviderWithIcon.
export function ProviderLabel({ provider }: { provider: string }) {
  const icon = PROVIDER_ICONS[provider];
  return (
    <span className="provider-label">
      <span className="provider-label-icon" aria-hidden>
        {icon ?? ''}
      </span>
      <span className="provider-label-name">{formatProvider(provider)}</span>
    </span>
  );
}
