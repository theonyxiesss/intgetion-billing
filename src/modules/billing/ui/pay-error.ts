export type PayErrorKind = "wallet" | "cancel" | "network" | "token" | "failed";

function rejected(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === 4001) return true;
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string" && /user rejected|user denied/i.test(message)
  );
}

/** What the pay screen should say. A closed wallet is not a failed payment. */
export function classifyPayError(error: unknown): PayErrorKind {
  if (rejected(error)) return "cancel";
  const message = error instanceof Error ? error.message : "";
  if (message === "wallet" || message === "network" || message === "token") {
    return message;
  }
  return "failed";
}
