export type BillingPorts = {
  notifyPlatformOwners: (subject: string, text: string) => Promise<void>;
  findMemberRole: (
    companyId: string,
    userId: string,
  ) => Promise<string | null | undefined>;
};

let ports: BillingPorts | null = null;

export function setBillingPorts(next: BillingPorts): void {
  ports = next;
}

export function billingPorts(): BillingPorts {
  if (!ports) throw new Error("billing ports are not configured");
  return ports;
}
