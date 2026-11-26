import { useEffect, useState } from "react";
import { api } from "../api";
import { Modal } from "./common";

export function KeychainUpdateDialog({
  previewCount,
  onPreviewClose,
}: { previewCount?: number; onPreviewClose?: () => void } = {}) {
  const [ids, setIds] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(0);

  useEffect(() => {
    if (previewCount !== undefined) return;
    void api.profiles
      .postUpdateKeychain()
      .then((connections) => {
        if (connections.length) setIds(connections);
      })
      .catch(() => undefined);
  }, [previewCount]);

  if (!ids.length && previewCount === undefined) return null;
  const count = previewCount ?? ids.length;
  const dismiss = () => {
    if (busy) return;
    if (onPreviewClose) onPreviewClose();
    else setIds([]);
  };

  async function authorizeAll() {
    if (previewCount !== undefined) {
      dismiss();
      return;
    }
    setBusy(true);
    let failures = 0;
    for (const [index, id] of ids.entries()) {
      setProgress(index + 1);
      try {
        await api.profiles.authorizeKeychain(id);
      } catch {
        failures++;
      }
    }
    setBusy(false);
    if (failures) setFailed(failures);
    else setIds([]);
  }

  return (
    <Modal
      narrow
      title="One quick favor… 🥺👉👈"
      onClose={dismiss}
      footer={
        <>
          <button className="btn" disabled={busy} onClick={dismiss}>
            When I connect
          </button>
          <button
            className="btn primary"
            disabled={busy || failed > 0}
            onClick={() => void authorizeAll()}
          >
            {busy
              ? `Checking ${progress} of ${count}…`
              : `Confirm all (${count})`}
          </button>
        </>
      }
    >
      <p>
        EarthQL uses <b>Ad-Hoc Signing</b>, so each update gets a new signature.
        macOS may go “new app, who’s this?” and ask for{" "}
        <b>Keychain access again</b> . Sorry for the extra clicks!
      </p>
      <p>Confirm now, or when you connect.</p>
      {failed > 0 && (
        <p role="status">
          {failed} still need approval. Try again when connecting.
        </p>
      )}
    </Modal>
  );
}
