"use client";

import { useEffect, useState } from "react";
import { Download, Share2 } from "lucide-react";
import Modal from "@/components/ui/Modal";
import { DIFFICULTY_LEVELS } from "@/lib/game/constants";
import {
  createResultCardBlob,
  downloadResultCard,
  normalizePlayerName,
  resultFilename,
  resultShareText,
  type ResultCardData,
} from "@/lib/share/result-card";

export default function ResultShareModal({
  data,
  onClose,
  onToast,
}: {
  data: ResultCardData;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    void createResultCardBlob(data)
      .then((image) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(image);
        setBlob(image);
        setPreviewUrl(objectUrl);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [data]);

  const download = () => {
    if (!blob) return;
    downloadResultCard(blob, data);
    onToast("Match card downloaded");
  };

  const share = async () => {
    if (!blob || busy) return;
    setBusy(true);
    const file = new File([blob], resultFilename(data), { type: "image/png" });
    const payload = {
      title: "My Jev Pong result",
      text: resultShareText(data),
      files: [file],
    };
    try {
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share(payload);
      } else {
        downloadResultCard(blob, data);
        onToast("Match card downloaded — ready to share");
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        downloadResultCard(blob, data);
        onToast("Match card downloaded — ready to share");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Your match receipt" onClose={onClose} wide>
      <p className="modal-description share-description">
        {normalizePlayerName(data.playerName)} vs. Jev. The score and session
        metrics come directly from this match.
      </p>
      <div className="result-card-preview" aria-live="polite">
        {previewUrl ? (
          // This is a local object URL generated entirely in the browser.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={`Match card showing ${normalizePlayerName(data.playerName)} ${data.humanScore}, Jev ${data.agentScore}${data.difficulty ? ` on ${DIFFICULTY_LEVELS[data.difficulty].label}` : ""}`}
          />
        ) : error ? (
          <div className="result-card-loading">
            We couldn’t build the image in this browser.
          </div>
        ) : (
          <div className="result-card-loading">Building your match card…</div>
        )}
      </div>
      <div className="share-note">
        Your name appears only on the image you choose to download or share.
      </div>
      <div className="share-actions">
        <button
          className="secondary-button"
          onClick={download}
          disabled={!blob}
        >
          <Download size={16} /> Download PNG
        </button>
        <button
          className="primary-button"
          onClick={share}
          disabled={!blob || busy}
        >
          <Share2 size={16} /> {busy ? "Opening share…" : "Share result"}
        </button>
      </div>
    </Modal>
  );
}
