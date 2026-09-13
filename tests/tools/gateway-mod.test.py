import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import sys
import unittest
import zipfile

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("gateway_publish", Path(__file__).resolve().parents[2] / "tools/release/publish-gateway-mod.py")
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class GatewayReleaseTests(unittest.TestCase):
    def artifact(self, directory):
        path = Path(directory) / "surfexp_gateways_0.6.6.zip"
        with zipfile.ZipFile(path, "w") as archive:
            root = "surfexp_gateways_0.6.6/"
            archive.writestr(root + "info.json", json.dumps({"name": MOD.MOD, "version": "0.6.6",
                "factorio_version": "2.1", "dependencies": ["base", "space-age >= 2.1.0"]}))
            for name in ("thumbnail.png", "LICENSE.md", "changelog.txt"):
                archive.writestr(root + name, "fixture")
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def test_artifact_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path, digest = self.artifact(directory)
            data, artifact = MOD.inspect_artifact(path, "0.6.6", digest)
            self.assertEqual(artifact["sha256"], digest)
            self.assertEqual(artifact["sha1"], hashlib.sha1(data).hexdigest())
            for version, sha in (("0.6.7", digest), ("0.6.6", "0" * 64), ("../0.6.6", digest)):
                with self.assertRaises(ValueError):
                    MOD.inspect_artifact(path, version, sha)

    def test_publication_protocol_keeps_key_off_upload_request(self):
        calls = []
        artifact = {"version": "0.6.6", "sha1": "abc"}

        def request(url, data=None, headers=None):
            calls.append((url, data, headers))
            return [{"releases": []}, {"upload_url": "https://direct.mods.factorio.com/upload/example"},
                    {"success": True}][len(calls) - 1]

        self.assertEqual(MOD.publish(b"zip-bytes", artifact, "test-key", request), "published")
        self.assertEqual(calls[1][2]["Authorization"], "Bearer test-key")
        self.assertNotIn("Authorization", calls[2][2])
        self.assertIn(b"zip-bytes", calls[2][1])
        self.assertIn(b"surfexp_gateways_0.6.6.zip", calls[2][1])

    def test_repeat_is_noop_only_for_matching_bytes(self):
        for sha, outcome in (("abc", "already-published"), ("other", None)):
            calls = []
            def request(url, *args):
                calls.append(url)
                return {"releases": [{"version": "0.6.6", "sha1": sha}]}
            if outcome:
                self.assertEqual(MOD.publish(b"zip", {"version": "0.6.6", "sha1": "abc"}, "key", request), outcome)
            else:
                with self.assertRaisesRegex(ValueError, "different bytes"):
                    MOD.publish(b"zip", {"version": "0.6.6", "sha1": "abc"}, "key", request)
            self.assertEqual(len(calls), 1)

    def test_untrusted_upload_url_and_missing_confirmation(self):
        for url in ("http://mods.factorio.com/upload", "https://evil.example/upload", "https://factorio.com.evil.example/upload",
                    "https://factorio.com:invalid/token", None, "https://user:token@mods.factorio.com/upload"):
            calls = []
            def request(endpoint, *args):
                calls.append(endpoint)
                return {"releases": []} if len(calls) == 1 else {"upload_url": url}
            with self.assertRaisesRegex(ValueError, "trusted upload URL"):
                MOD.publish(b"zip", {"version": "0.6.6"}, "key", request)
            self.assertEqual(len(calls), 2)
        replies = iter([{"releases": []}, {"upload_url": "https://direct.mods.factorio.com/upload"}, {"success": False}])
        with self.assertRaisesRegex(ValueError, "did not confirm"):
            MOD.publish(b"zip", {"version": "0.6.6"}, "key", lambda *args: next(replies))

    def test_missing_key_and_redirect_refusal(self):
        with self.assertRaisesRegex(ValueError, "API_KEY"):
            MOD.publish(b"zip", {}, "", lambda *args: self.fail("network must not be called"))
        self.assertIsNone(MOD.NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.test"))


if __name__ == "__main__":
    unittest.main()
