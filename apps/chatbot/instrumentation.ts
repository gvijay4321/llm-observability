// Next.js loads this on every runtime boot (one per server process, one per
// edge worker). The OTel SDK is Node-only, so skip on edge.
export async function register(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[instrumentation] register() runtime=${process.env.NEXT_RUNTIME ?? 'undefined'}`);
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { initChatbotTelemetry } = await import('./lib/telemetry');
    await initChatbotTelemetry();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[instrumentation] telemetry init failed:', err);
  }
}
