"use client";

import { useState } from "react";
import { Braces, Info } from "lucide-react";
import Modal from "@/components/ui/Modal";
import type { DecisionEvent } from "@/lib/telemetry/session";

export default function RawInspector({
  event,
  onClose,
}: {
  event: DecisionEvent | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"state" | "decision" | "raw">("state");
  const data = event
    ? tab === "state"
      ? event.snapshot
      : tab === "decision"
        ? { decision: event.decision, appliedAction: event.appliedAction }
        : event.rawResponse
    : null;
  return (
    <Modal title="Inside the decision" onClose={onClose} wide>
      <p className="modal-description">
        The exact game snapshot, structured decision, and provider response.
        These are observable outputs, not private model reasoning.
      </p>
      <div className="inspector-tabs" role="tablist" aria-label="Decision data">
        {(
          [
            ["state", "Game state"],
            ["decision", "Decision + policy"],
            ["raw", "Provider response"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {event ? (
        <pre className="json-view" tabIndex={0}>
          <code>{JSON.stringify(data, null, 2)}</code>
        </pre>
      ) : (
        <div className="inspector-empty">
          <Braces size={30} />
          <h3>The first move is yours.</h3>
          <p>Start a match to inspect a decision.</p>
        </div>
      )}
      <div className="inspector-note">
        <Info size={14} /> Credentials and request headers are excluded.
      </div>
    </Modal>
  );
}
