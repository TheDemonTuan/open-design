#!/usr/bin/env python3
"""
Secure OpenDesign Handoff Package Importer
Validates ZIP security (Zip Slip, zip bomb, symlink traversal),
extracts into an immutable versioned directory, and atomically updates
the 'current' symlink for consuming AI agents and frontend workflows.
"""

import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import zipfile

MAX_TOTAL_UNCOMPRESSED_BYTES = 500 * 1024 * 1024  # 500 MB
MAX_ENTRY_COUNT = 5000
MAX_INDIVIDUAL_FILE_BYTES = 100 * 1024 * 1024     # 100 MB


class HandoffImportError(RuntimeError):
    pass


def validate_zip_security(zf: zipfile.ZipFile) -> tuple[int, int]:
    """Validate zipfile against Zip Slip, zip bombs, and unsafe entries."""
    total_uncompressed = 0
    entries = zf.infolist()

    if len(entries) > MAX_ENTRY_COUNT:
        raise HandoffImportError(
            f"Package rejected: exceeds maximum allowed file count ({len(entries)} > {MAX_ENTRY_COUNT})"
        )

    for entry in entries:
        filename = entry.filename

        # Zip Slip path traversal checks
        if filename.startswith(('/', '\\')) or (len(filename) > 1 and filename[1] == ':'):
            raise HandoffImportError(f"Security violation: absolute path in ZIP entry: {filename}")

        parts = Path(filename).parts
        if '..' in parts:
            raise HandoffImportError(f"Security violation: path traversal ('..') in entry: {filename}")

        # Individual size limits
        if entry.file_size > MAX_INDIVIDUAL_FILE_BYTES:
            raise HandoffImportError(
                f"Security violation: file exceeds max size limit ({entry.file_size} > {MAX_INDIVIDUAL_FILE_BYTES}): {filename}"
            )

        total_uncompressed += entry.file_size
        if total_uncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES:
            raise HandoffImportError(
                f"Security violation: total uncompressed size exceeds limit ({total_uncompressed} > {MAX_TOTAL_UNCOMPRESSED_BYTES})"
            )

    return len(entries), total_uncompressed


def atomic_symlink(target_path: Path, link_path: Path) -> None:
    """Atomically create or replace link_path pointing to target_path."""
    parent = link_path.parent
    parent.mkdir(parents=True, exist_ok=True)
    temp_link = parent / f".symlink_tmp_{os.getpid()}_{datetime.datetime.now().strftime('%f')}"

    try:
        if temp_link.exists() or temp_link.is_symlink():
            temp_link.unlink()
        os.symlink(target_path, temp_link)
        os.replace(temp_link, link_path)
    except Exception as exc:
        if temp_link.exists() or temp_link.is_symlink():
            try:
                temp_link.unlink()
            except OSError:
                pass
        raise HandoffImportError(f"Failed to atomically update symlink: {exc}") from exc


def import_handoff(zip_file_path: Path, handoff_root: Path) -> dict:
    zip_file_path = zip_file_path.resolve()
    if not zip_file_path.is_file():
        raise HandoffImportError(f"Handoff ZIP file does not exist: {zip_file_path}")

    if not zipfile.is_zipfile(zip_file_path):
        raise HandoffImportError(f"File is not a valid ZIP archive: {zip_file_path}")

    handoff_root = handoff_root.resolve()
    packages_dir = handoff_root / "packages"
    packages_dir.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(zip_file_path, 'r') as zf:
        entry_count, total_bytes = validate_zip_security(zf)

        # Inspect manifest or identify project
        manifest_data = {}
        project_id = "unknown-project"
        if "manifest.json" in zf.namelist():
            try:
                manifest_data = json.loads(zf.read("manifest.json").decode("utf-8"))
                project_id = manifest_data.get("projectId") or manifest_data.get("id") or project_id
            except Exception:
                pass

        timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        dest_dir_name = f"{project_id}-{timestamp}"
        extract_dir = packages_dir / dest_dir_name

        if extract_dir.exists():
            shutil.rmtree(extract_dir)
        extract_dir.mkdir(parents=True, mode=0o755)

        # Safe extraction
        for entry in zf.infolist():
            target_entry_path = (extract_dir / entry.filename).resolve()
            if not target_entry_path.is_relative_to(extract_dir):
                raise HandoffImportError(f"Zip slip escape detected on extraction: {entry.filename}")

            if entry.is_dir():
                target_entry_path.mkdir(parents=True, exist_ok=True)
            else:
                target_entry_path.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(entry) as src, open(target_entry_path, "wb") as dst:
                    shutil.copyfileobj(src, dst)

        # Atomically point current symlink to the new extraction
        current_link = handoff_root / "current"
        atomic_symlink(extract_dir, current_link)

        # Check for presence of essential handoff files
        has_design_md = (extract_dir / "DESIGN.md").is_file()
        has_spec = (extract_dir / "design-spec").is_dir() or (extract_dir / "spec.json").is_file()
        has_tokens = (extract_dir / "tokens").is_dir()

        return {
            "status": "success",
            "projectId": project_id,
            "version": dest_dir_name,
            "extractedDir": str(extract_dir),
            "currentSymlink": str(current_link),
            "filesExtracted": entry_count,
            "totalBytes": total_bytes,
            "hasDesignMd": has_design_md,
            "hasSpec": has_spec,
            "hasTokens": has_tokens,
            "importedAt": timestamp,
        }


def main():
    parser = argparse.ArgumentParser(description="Import OpenDesign Handoff ZIP package")
    parser.add_argument("zip_path", type=Path, help="Path to handoff ZIP file")
    parser.add_argument(
        "--target-dir",
        type=Path,
        default=Path(os.environ.get("DESIGN_HANDOFF_DIR", Path.home() / "DesignHandoff")),
        help="Root directory for handoff storage (default: ~/DesignHandoff)",
    )
    parser.add_argument("--json", action="store_true", help="Output result as JSON")

    args = parser.parse_args()

    try:
        result = import_handoff(args.zip_path, args.target_dir)
        if args.json:
            print(json.dumps(result, indent=2))
        else:
            print("==> OpenDesign Handoff Package Imported Successfully")
            print(f"Project ID:      {result['projectId']}")
            print(f"Version:         {result['version']}")
            print(f"Extracted to:    {result['extractedDir']}")
            print(f"Current symlink: {result['currentSymlink']}")
            print(f"Files / Bytes:   {result['filesExtracted']} files / {result['totalBytes']} bytes")
            print(f"DESIGN.md:       {'Yes' if result['hasDesignMd'] else 'No'}")
            print(f"Design Spec:     {'Yes' if result['hasSpec'] else 'No'}")
            print(f"Tokens:          {'Yes' if result['hasTokens'] else 'No'}")
    except HandoffImportError as err:
        if args.json:
            print(json.dumps({"status": "error", "error": str(err)}))
        else:
            print(f"ERROR: {err}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
