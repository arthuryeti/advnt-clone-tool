export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@/lib/render-reconciler");
    const { startJobReconciler } = await import("@/lib/jobs");
    startJobReconciler();
  }
}
