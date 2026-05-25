export interface MetricWindow {
  label: string;
  value: number;
}

export const METRIC_WINDOWS: MetricWindow[] = [
  { label: 'Last 15 min', value: 15 },
  { label: 'Last hour', value: 60 },
  { label: 'Last 6 hours', value: 360 },
  { label: 'Last 24 hours', value: 1440 },
  { label: 'Last 7 days', value: 60 * 24 * 7 },
  { label: 'Last 30 days', value: 60 * 24 * 30 },
  { label: 'Last year', value: 60 * 24 * 365 },
];

export const DEFAULT_WINDOW = 60 * 24 * 7;

export function windowLabel(minutes: number): string {
  // Match the preset wording so the bubble reads like the dropdown.
  const preset = METRIC_WINDOWS.find((w) => w.value === minutes);
  if (preset) return preset.label.replace(/^Last/, 'last');
  if (minutes < 60) return `last ${minutes} min`;
  const h = minutes / 60;
  if (h < 24) return h === 1 ? 'last hour' : `last ${h} hours`;
  const d = h / 24;
  if (d < 30) return d === 1 ? 'last 24 hours' : `last ${Math.round(d)} days`;
  if (d < 365) return `last ${Math.round(d / 30)} months`;
  return `last ${Math.round(d / 365)} year`;
}
