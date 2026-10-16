import { useEffect, useRef, useState } from 'react';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import {
  FIRST_CHECK_DELAY_MS,
  autoCheckOn,
  downloadPercent,
  lastCheck,
  markChecked,
  shouldAutoCheck,
  shouldNotify,
  skipVersion,
  skippedVersion,
} from '../updater';

// Checks for a newer boonsh (once a day after start, or from Settings > About) and installs it on request.
// `confirmClose`: asked before installing, since the installer closes boonsh (false = do not install now).
export function useUpdater(confirmClose: () => boolean) {
  const [update, setUpdate] = useState<Update | null>(null); // found and shown in the notice
  const [installing, setInstalling] = useState<string | null>(null); // progress text while downloading
  const checkingRef = useRef(false);

  const find = async (): Promise<Update | null> => {
    if (checkingRef.current) return null;
    checkingRef.current = true;
    try {
      return await check();
    } finally {
      checkingRef.current = false;
    }
  };

  // the automatic check: quiet, no message when there is nothing new or the network is off
  useEffect(() => {
    const t = setTimeout(() => {
      if (!shouldAutoCheck(Date.now(), lastCheck(), autoCheckOn())) return;
      markChecked();
      find()
        .then((u) => {
          if (u && shouldNotify(u.version, skippedVersion())) setUpdate(u);
        })
        .catch(() => {});
    }, FIRST_CHECK_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  /** Settings > About: check now; the answer is a sentence for the page. A found update also shows the notice. */
  const checkNow = async (): Promise<string> => {
    try {
      const u = await find();
      markChecked();
      if (!u) return 'You have the newest version.';
      setUpdate(u);
      return `boonsh ${u.version} is available. The notice at the bottom left can install it.`;
    } catch (err) {
      // the newest GitHub release has no latest.json (it came out before updates were built in)
      if (/valid release JSON/i.test(String(err))) return 'No update information was found on GitHub yet. Updates work from the next release on.';
      return `Could not check for updates: ${String(err)}`;
    }
  };

  const later = () => {
    if (update) skipVersion(update.version);
    setUpdate(null);
  };

  const install = async () => {
    if (!update || installing !== null) return;
    if (!confirmClose()) return;
    let total: number | undefined;
    let done = 0;
    setInstalling('Downloading…');
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === 'Started') total = e.data.contentLength;
        else if (e.event === 'Progress') {
          done += e.data.chunkLength;
          const pct = downloadPercent(done, total);
          setInstalling(pct ? `Downloading ${pct}` : 'Downloading…');
        } else if (e.event === 'Finished') setInstalling('Installing…');
      });
      // Windows: the installer has already closed boonsh and starts it again. Elsewhere: restart now.
      await relaunch();
    } catch (err) {
      setInstalling(null);
      alert(`The update could not be installed: ${String(err)}`);
    }
  };

  return { update, installing, checkNow, later, install };
}
