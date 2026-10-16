"""Write latest.json for the boonsh updater (tauri-plugin-updater) after `npm run tauri build`.

The app asks https://github.com/ssaelao-wq/boonsh/releases/latest/download/latest.json for the newest version, so
upload the file this script writes to the GitHub release together with the two installers (same file names as
built). The build must have been signed (TAURI_SIGNING_PRIVATE_KEY set), which leaves a `.sig` next to each
installer; the release notes are taken from that version's section in RELEASE.md.

    python scripts/make-latest-json.py            -> src-tauri/target/release/bundle/latest.json
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "https://github.com/ssaelao-wq/boonsh"
BUNDLE = ROOT / "src-tauri" / "target" / "release" / "bundle"


def release_notes(version: str) -> str:
    text = (ROOT / "RELEASE.md").read_text(encoding="utf-8")
    m = re.search(rf"^## {re.escape(version)}\b.*?$(.*?)(?=^## |\Z)", text, re.S | re.M)
    if not m:
        return f"boonsh {version}"
    notes = m.group(1).strip()
    notes = re.sub(r"\*\*(.+?)\*\*", r"\1", notes)  # plain text in the update notice
    notes = re.sub(r"`([^`]+)`", r"\1", notes)
    return notes


def main() -> int:
    version = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))["version"]
    files = {
        "nsis": BUNDLE / "nsis" / f"boonsh_{version}_x64-setup.exe",
        "msi": BUNDLE / "msi" / f"boonsh_{version}_x64_en-US.msi",
    }
    platforms = {}
    for kind, installer in files.items():
        sig = installer.with_name(installer.name + ".sig")
        if not installer.exists() or not sig.exists():
            print(f"missing {installer.name} or its .sig: build with TAURI_SIGNING_PRIVATE_KEY set", file=sys.stderr)
            return 1
        platforms[f"windows-x86_64-{kind}"] = {
            "signature": sig.read_text(encoding="utf-8").strip(),
            "url": f"{REPO}/releases/download/v{version}/{installer.name}",
        }
    # an install that does not know its installer type takes the setup .exe
    platforms["windows-x86_64"] = platforms["windows-x86_64-nsis"]
    out = {
        "version": version,
        "notes": release_notes(version),
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": platforms,
    }
    target = BUNDLE / "latest.json"
    target.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {target}")
    print(f"upload it with boonsh_{version}_x64-setup.exe and boonsh_{version}_x64_en-US.msi to the release v{version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
