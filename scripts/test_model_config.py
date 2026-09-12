import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from model_bundle import install_bundle, safe_path
from model_config import checkpoint_path, read_config, sha256


class ModelConfigTests(unittest.TestCase):
    def test_config_and_local_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkpoint = root / "weights.pt"
            checkpoint.write_bytes(b"checkpoint")
            path = root / "model.json"
            root_config = {
                "schemaVersion": 3,
                "analysis": {"mode": "both"},
                "maia3": {"model": "3m", "source": {"type": "local", "path": "weights.pt"}},
                "stockfish": {"version": "18.0.8", "flavor": "lite-single"},
                "lc0": {"version": "0.32.1", "weights": {"url": "https://example.invalid/weights.pb.gz", "sha256": "a" * 64}, "backend": "cpu", "platforms": ["linux-x64"]},
            }
            path.write_text(json.dumps(root_config))
            actual, config_path = read_config(path)
            self.assertEqual(actual, {"schemaVersion": 1, **root_config["maia3"]})
            self.assertEqual(checkpoint_path(actual, config_path), checkpoint)
            self.assertEqual(len(sha256(checkpoint)), 64)
            spaced = root / " weights.pt "
            checkpoint.rename(spaced)
            root_config["maia3"]["source"]["path"] = spaced.name
            path.write_text(json.dumps(root_config))
            actual, config_path = read_config(path)
            self.assertEqual(actual["source"]["path"], spaced.name)
            self.assertEqual(checkpoint_path(actual, config_path), spaced)
            spaced.unlink()
            with self.assertRaisesRegex(ValueError, "checkpoint not found"):
                checkpoint_path(actual, config_path)

    def test_invalid_config(self):
        valid = {
            "schemaVersion": 3,
            "analysis": {"mode": "both"},
            "maia3": {
                "model": "5m",
                "source": {
                    "type": "huggingface", "repoId": "example/maia3",
                    "filename": "maia3-5m.pt",
                    "revision": "0123456789abcdef0123456789abcdef01234567",
                },
            },
            "stockfish": {"version": "18.0.8", "flavor": "lite-single"},
            "lc0": {"version": "0.32.1", "weights": {"url": "https://example.invalid/weights.pb.gz", "sha256": "a" * 64}, "backend": "cpu", "platforms": ["linux-x64"]},
        }
        cases = [[], {**valid, "maia3": {**valid["maia3"], "model": "unknown"}},
                 {**valid, "schemaVersion": True}, {**valid, "extra": 1},
                 {**valid, "maia3": {**valid["maia3"], "source": {**valid["maia3"]["source"], "revision": "main"}}},
                 {**valid, "maia3": {**valid["maia3"], "source": {"type": "other", "path": "x"}}},
                 {**valid, "stockfish": {**valid["stockfish"], "version": "01.2.3"}},
                 {**valid, "stockfish": {**valid["stockfish"], "version": "18.0"}},
                 {**valid, "stockfish": {**valid["stockfish"], "flavor": "unknown"}},
                 {**valid, "analysis": {"mode": "unknown"}},
                 {**valid, "lc0": {**valid["lc0"], "backend": "unknown"}},
                 {**valid, "lc0": {**valid["lc0"], "weights": {**valid["lc0"]["weights"], "sha256": "bad"}}}]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            for config in cases:
                with self.subTest(config=config):
                    path.write_text(json.dumps(config))
                    with self.assertRaises(ValueError):
                        read_config(path)

    def test_stockfish_changes_do_not_change_normalized_maia_config(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            config = {
                "schemaVersion": 3,
                "analysis": {"mode": "both"},
                "maia3": {"model": "5m", "source": {"type": "local", "path": "weights.pt"}},
                "stockfish": {"version": "18.0.8", "flavor": "lite-single"},
                "lc0": {"version": "0.32.1", "weights": {"url": "https://example.invalid/weights.pb.gz", "sha256": "a" * 64}, "backend": "cpu", "platforms": ["linux-x64"]},
            }
            (Path(directory) / "weights.pt").write_bytes(b"weights")
            path.write_text(json.dumps(config))
            first, _ = read_config(path)
            config["stockfish"] = {"version": "19.0.0", "flavor": "full"}
            path.write_text(json.dumps(config))
            second, _ = read_config(path)
            self.assertEqual(first, second)

    def test_legacy_schema_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps({
                "schemaVersion": 1, "model": "5m",
                "source": {"type": "local", "path": "weights.pt"},
            }))
            with self.assertRaisesRegex(ValueError, "configuration version|configuration fields"):
                read_config(path)

    def test_unsafe_paths(self):
        for name in ("../file", "/file", "C:/file", "a\\b", "a//b", "./file", ""):
            with self.subTest(name=name), self.assertRaises(ValueError):
                safe_path("/tmp", name)

    def test_bundle_install_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            staging, destination = root / "staging", root / "models"
            staging.mkdir()
            destination.mkdir()
            for name in ("model.onnx", "manifest.json"):
                (staging / name).write_text("new")
                (destination / name).write_text("old")
            import os
            replace = os.replace

            def fail_manifest(source, target):
                if source == staging / "manifest.json":
                    raise OSError("simulated installation failure")
                return replace(source, target)

            with patch("model_bundle.os.replace", side_effect=fail_manifest):
                with self.assertRaisesRegex(OSError, "simulated"):
                    install_bundle(staging, destination, ["model.onnx"])
            for name in ("model.onnx", "manifest.json"):
                self.assertEqual((destination / name).read_text(), "old")

    def test_bundle_install(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            staging, destination = root / "staging", root / "models"
            staging.mkdir()
            destination.mkdir()
            for name in ("model.onnx", "manifest.json"):
                (staging / name).write_text("new")
            install_bundle(staging, destination, ["model.onnx"])
            self.assertEqual((destination / "model.onnx").read_text(), "new")
            self.assertEqual((destination / "manifest.json").read_text(), "new")


if __name__ == "__main__":
    unittest.main()
