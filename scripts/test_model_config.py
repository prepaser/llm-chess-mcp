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
            config = {"schemaVersion": 1, "model": "3m", "source": {"type": "local", "path": "weights.pt"}}
            path.write_text(json.dumps(config))
            actual, config_path = read_config(path)
            self.assertEqual(actual, config)
            self.assertEqual(checkpoint_path(actual, config_path), checkpoint)
            self.assertEqual(len(sha256(checkpoint)), 64)
            checkpoint.unlink()
            with self.assertRaisesRegex(ValueError, "checkpoint not found"):
                checkpoint_path(actual, config_path)

    def test_invalid_config(self):
        valid, _ = read_config()
        cases = [[], {**valid, "model": "unknown"}, {**valid, "schemaVersion": True},
                 {**valid, "extra": 1}, {**valid, "source": {**valid["source"], "revision": "main"}},
                 {**valid, "source": {"type": "other", "path": "x"}}]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            for config in cases:
                with self.subTest(config=config):
                    path.write_text(json.dumps(config))
                    with self.assertRaises(ValueError):
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
