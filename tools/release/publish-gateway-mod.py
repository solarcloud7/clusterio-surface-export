#!/usr/bin/env python3
# requires: reviewed gateway ZIP, expected version/SHA256; scoped API key for --publish
# produces: validated artifact identity; with --publish, one Mod Portal release
# does not: rebuild the ZIP, create a mod listing, deploy servers, or synchronize clients
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

MOD = "surfexp_gateways"
PORTAL = "https://mods.factorio.com"


def inspect_artifact(path, version, sha256):
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", version):
        raise ValueError("Expected a Factorio mod version such as 0.6.6")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", sha256):
        raise ValueError("Expected a full SHA256")
    if path.stat().st_size > 64 * 1024 * 1024:
        raise ValueError("Gateway ZIP exceeds 64 MiB")
    data = path.read_bytes()
    actual = hashlib.sha256(data).hexdigest()
    if actual != sha256.lower():
        raise ValueError("ZIP differs from the reviewed SHA256")
    prefix = f"{MOD}_{version}/"
    if path.name != prefix[:-1] + ".zip":
        raise ValueError("ZIP filename does not match the expected mod/version")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if sum(entry.file_size for entry in entries) > 256 * 1024 * 1024:
            raise ValueError("Expanded ZIP exceeds 256 MiB")
        names = [entry.filename for entry in entries]
        if len(set(names)) != len(names):
            raise ValueError("ZIP contains duplicate entries")
        for name in names:
            if not name.startswith(prefix) or "\\" in name or ".." in PurePosixPath(name).parts:
                raise ValueError("ZIP contains an unexpected mod root or path")
        info = json.loads(archive.read(prefix + "info.json"))
        if info.get("name") != MOD or info.get("version") != version or info.get("factorio_version") != "2.1":
            raise ValueError("info.json does not match the requested gateway release")
        if not any(re.match(r"^space-age(?:\s|$)", dep) for dep in info.get("dependencies", [])):
            raise ValueError("Gateway release must require Space Age")
        for name in ("thumbnail.png", "LICENSE.md", "changelog.txt"):
            if not archive.read(prefix + name):
                raise ValueError(f"Empty {name}")
        if archive.testzip():
            raise ValueError("ZIP integrity check failed")
    return data, {"mod": MOD, "version": version, "sha256": actual,
                  "sha1": hashlib.sha1(data).hexdigest(), "bytes": len(data)}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_json(url, data=None, headers=None):
    request = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=120) as response:
            payload = response.read(1024 * 1024 + 1)
            if len(payload) > 1024 * 1024:
                raise ValueError("Mod Portal response exceeds 1 MiB")
            result = json.loads(payload)
            if not isinstance(result, dict):
                raise ValueError("Mod Portal returned an unexpected response")
            return result
    except urllib.error.HTTPError as error:
        if error.code == 404 and url == f"{PORTAL}/api/mods/{MOD}":
            raise ValueError("Create the initial mod listing in the Mod Portal before publishing updates") from None
        raise ValueError(f"Mod Portal returned HTTP {error.code}; inspect the release page before retrying") from None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        raise ValueError("Mod Portal response unavailable; inspect the release page before retrying") from None


def publish(data, artifact, api_key, request=request_json):
    if not api_key or "\n" in api_key or "\r" in api_key:
        raise ValueError("Set FACTORIO_MOD_PORTAL_API_KEY with the ModPortal: Upload Mods permission")
    listing = request(f"{PORTAL}/api/mods/{MOD}")
    for release in listing.get("releases", []):
        if release.get("version") == artifact["version"]:
            if release.get("sha1") == artifact["sha1"]:
                return "already-published"
            raise ValueError("That mod version is already published with different bytes")
    initialized = request(f"{PORTAL}/api/v2/mods/releases/init_upload",
        urllib.parse.urlencode({"mod": MOD}).encode(),
        {"Authorization": f"Bearer {api_key}", "Content-Type": "application/x-www-form-urlencoded"})
    upload_url = initialized.get("upload_url", "")
    try:
        parsed = urllib.parse.urlsplit(upload_url)
        trusted = (parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password
            and parsed.port in (None, 443)
            and (parsed.hostname == "factorio.com" or parsed.hostname.endswith(".factorio.com")))
    except (TypeError, ValueError):
        trusted = False
    if not trusted:
        raise ValueError("Mod Portal did not return a trusted upload URL")
    boundary = "gateway-" + uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
            f'filename="{MOD}_{artifact["version"]}.zip"\r\nContent-Type: application/zip\r\n\r\n').encode()
    body += data + f"\r\n--{boundary}--\r\n".encode()
    result = request(upload_url, body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    if result.get("success") is not True:
        raise ValueError("Mod Portal did not confirm publication; inspect the release page before retrying")
    return "published"


def main():
    parser = argparse.ArgumentParser(description="Validate or publish the exact reviewed gateway mod ZIP")
    parser.add_argument("zip", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    data, artifact = inspect_artifact(args.zip, args.version, args.sha256)
    status = publish(data, artifact, os.getenv("FACTORIO_MOD_PORTAL_API_KEY")) if args.publish else "validated-only"
    print(json.dumps({**artifact, "status": status, "url": f"{PORTAL}/mod/{MOD}"}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        print(f"Gateway release failed: {error}", file=sys.stderr)
        sys.exit(1)
