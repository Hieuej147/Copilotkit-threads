"use client";

import { useInterrupt } from "@copilotkit/react-core/v2";
import { Check, CreditCard, ShieldCheck, X } from "lucide-react";

type PurchaseApproval = {
  kind: "purchase_approval";
  message: string;
  item: string;
  amountUsd: number;
};

function approvalFrom(value: unknown): PurchaseApproval | null {
  if (typeof value === "string") {
    try {
      return approvalFrom(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PurchaseApproval> & { metadata?: unknown };
  if (candidate.kind === "purchase_approval") return candidate as PurchaseApproval;
  if (candidate.metadata && typeof candidate.metadata === "object") {
    const metadata = candidate.metadata as Partial<PurchaseApproval>;
    if (metadata.kind === "purchase_approval") return metadata as PurchaseApproval;
  }
  return null;
}

export function PurchaseApprovalInterrupt() {
  useInterrupt({
    agentId: "default",
    enabled: (event) => approvalFrom(event.value) !== null,
    render: ({ event, interrupt, resolve }) => {
      const approval = approvalFrom(event.value) ?? approvalFrom(interrupt?.metadata);
      return (
        <section className="approval-interrupt" aria-label="Purchase approval">
          <div className="approval-icon"><ShieldCheck size={21} /></div>
          <div className="approval-copy">
            <span>Approval required</span>
            <strong>{approval?.item ?? "Purchase request"}</strong>
            <p>{approval?.message ?? interrupt?.message ?? "Review this purchase before continuing."}</p>
          </div>
          <div className="approval-amount">
            <CreditCard size={15} />
            <strong>${approval?.amountUsd?.toFixed(2) ?? "0.00"}</strong>
          </div>
          <div className="approval-actions">
            <button className="approval-reject" onClick={() => void resolve({ approved: false })}>
              <X size={15} /> Reject
            </button>
            <button className="approval-accept" onClick={() => void resolve({ approved: true })}>
              <Check size={15} /> Approve
            </button>
          </div>
        </section>
      );
    },
  });
  return null;
}
