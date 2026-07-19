"use client";

import {
  useComponent,
  useDefaultRenderTool,
  useFrontendTool,
  useHumanInTheLoop,
} from "@copilotkit/react-core/v2";
import { Check, Palette, UserRound, X } from "lucide-react";
import { z } from "zod";
import { PurchaseApprovalInterrupt } from "./purchase-approval-interrupt";
import { WeatherToolRenderer } from "./weather-tool-renderer";

export type Accent = "teal" | "coral" | "indigo";

export const accentColors: Record<Accent, string> = {
  teal: "#147d72",
  coral: "#c45f4b",
  indigo: "#5367b7",
};

const accentParameters = z.object({
  accent: z.enum(["teal", "coral", "indigo"]),
});

const profileParameters = z.object({
  name: z.string(),
  role: z.string(),
  status: z.enum(["active", "away"]),
});

const exportParameters = z.object({
  format: z.enum(["csv", "json"]),
  recordCount: z.number().int().nonnegative(),
});

function DemoProfileCard({
  name,
  role,
  status,
}: z.infer<typeof profileParameters>) {
  return (
    <section className="lab-tool-card">
      <div className="lab-tool-icon"><UserRound size={18} /></div>
      <div>
        <span>Render-only component</span>
        <strong>{name}</strong>
        <p>{role} · {status}</p>
      </div>
    </section>
  );
}

export function HookRegistrations({
  setAccent,
}: {
  setAccent: (accent: Accent) => void;
}) {
  useDefaultRenderTool(undefined, []);

  useFrontendTool(
    {
      name: "set_demo_accent",
      description: "Change the Hook Lab accent color. Use only when the user asks to change the demo accent.",
      parameters: accentParameters,
      agentId: "default",
      followUp: true,
      handler: async ({ accent }) => {
        setAccent(accent);
        return { changed: true, accent };
      },
      render: ({ status, args, result }) => (
        <section className="lab-tool-card">
          <div className="lab-tool-icon"><Palette size={18} /></div>
          <div>
            <span>Frontend tool · {status}</span>
            <strong>Accent: {args.accent ?? "pending"}</strong>
            {result && <p>{result}</p>}
          </div>
        </section>
      ),
    },
    [],
  );

  useComponent(
    {
      name: "show_demo_profile",
      description: "Display a demo user profile card when the user explicitly requests one.",
      parameters: profileParameters,
      agentId: "default",
      followUp: false,
      render: DemoProfileCard,
    },
    [],
  );

  useHumanInTheLoop(
    {
      name: "confirm_demo_export",
      description: "Ask for confirmation before a requested demo data export.",
      parameters: exportParameters,
      agentId: "default",
      followUp: true,
      render: ({ status, args, result, respond }) => (
        <section className="lab-hitl-card">
          <div>
            <span>Frontend HITL · {status}</span>
            <strong>Export {args.recordCount ?? 0} records as {args.format ?? "file"}</strong>
            {result && <p>{result}</p>}
          </div>
          {status === "executing" && (
            <div className="lab-hitl-actions">
              <button onClick={() => void respond({ approved: false })}>
                <X size={14} /> Reject
              </button>
              <button className="primary" onClick={() => void respond({ approved: true })}>
                <Check size={14} /> Confirm
              </button>
            </div>
          )}
        </section>
      ),
    },
    [],
  );

  return (
    <>
      <WeatherToolRenderer />
      <PurchaseApprovalInterrupt />
    </>
  );
}
