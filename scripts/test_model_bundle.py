import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from model_bundle import BundleInstallError, install_bundle


class ModelBundleTests(unittest.TestCase):
    def _bundle(self, root, names=("model.onnx",), staging_parent=None):
        staging = (staging_parent or root) / "staging"
        destination = root / "models"
        staging.mkdir()
        destination.mkdir(exist_ok=True)
        for name in (*names, "manifest.json"):
            source = staging / name
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text(f"new {name}")
        return staging, destination

    def test_success_removes_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            staging, destination = self._bundle(root)
            install_bundle(staging, destination, ["model.onnx"])
            self.assertFalse(list(root.glob(".maia-backup-*")))
            self.assertEqual((destination / "model.onnx").read_text(), "new model.onnx")

    def test_failure_rolls_back_and_outer_staging_cleanup_is_safe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "models"
            destination.mkdir()
            with tempfile.TemporaryDirectory(dir=root) as staging_directory:
                staging = Path(staging_directory)
                (staging / "model.onnx").write_text("new model")
                (staging / "manifest.json").write_text("new manifest")
                (destination / "model.onnx").write_text("old model")
                (destination / "manifest.json").write_text("old manifest")
                original_replace = os.replace

                def fail_manifest(source, target):
                    if source == staging / "manifest.json":
                        raise OSError("simulated installation failure")
                    return original_replace(source, target)

                with patch("model_bundle.os.replace", side_effect=fail_manifest):
                    with self.assertRaisesRegex(OSError, "simulated installation failure"):
                        install_bundle(staging, destination, ["model.onnx"])
            self.assertFalse(staging.exists())
            self.assertEqual((destination / "model.onnx").read_text(), "old model")
            self.assertEqual((destination / "manifest.json").read_text(), "old manifest")
            self.assertFalse(list(root.glob(".maia-backup-*")))

    def test_partial_rollback_continues_and_preserves_backup_mapping(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "models"
            with tempfile.TemporaryDirectory(dir=root) as staging_directory:
                staging, _ = self._bundle(root, ("nested/model.onnx", "other.bin"), Path(staging_directory))
                for name in ("nested/model.onnx", "other.bin", "manifest.json"):
                    target = destination / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(f"old {name}")
                original_replace = os.replace
                restore_targets = []

                def fail_install_and_restore(source, target):
                    if source == staging / "other.bin":
                        raise OSError("simulated installation failure")
                    if any(part.startswith(".maia-backup-") for part in source.parts):
                        restore_targets.append(target)
                        if target == destination / "other.bin":
                            raise OSError("simulated restore failure")
                    return original_replace(source, target)

                with patch("model_bundle.os.replace", side_effect=fail_install_and_restore):
                    with self.assertRaises(BundleInstallError) as raised:
                        install_bundle(staging, destination, ["nested/model.onnx", "other.bin"])
            error = raised.exception
            self.assertEqual(len(error.errors), 2)
            self.assertIn("simulated installation failure", str(error))
            self.assertIn("simulated restore failure", str(error))
            self.assertEqual(restore_targets, [destination / "other.bin", destination / "nested/model.onnx"])
            self.assertEqual((destination / "nested/model.onnx").read_text(), "old nested/model.onnx")
            self.assertFalse((destination / "other.bin").exists())
            self.assertEqual(set(error.backup_paths), {"other.bin"})
            backup = error.backup_paths["other.bin"]
            self.assertTrue(backup.is_absolute())
            self.assertTrue(backup.is_file())
            self.assertEqual(backup.read_text(), "old other.bin")
            self.assertTrue(backup.parent.parent.name == root.name)

    def test_install_cleanup_failure_keeps_backup_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            staging, destination = self._bundle(root)
            with patch("model_bundle.shutil.rmtree", side_effect=OSError("simulated cleanup failure")):
                with self.assertRaises(BundleInstallError) as raised:
                    install_bundle(staging, destination, ["model.onnx"])
            error = raised.exception
            backup = error.backup_paths["backup"]
            self.assertIn("simulated cleanup failure", str(error))
            self.assertEqual((destination / "model.onnx").read_text(), "new model.onnx")
            self.assertTrue(backup.is_dir())

    def test_rollback_cleanup_failure_keeps_backup_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            staging, destination = self._bundle(root)
            (destination / "model.onnx").write_text("old model")
            (destination / "manifest.json").write_text("old manifest")
            original_replace = os.replace

            def fail_manifest(source, target):
                if source == staging / "manifest.json":
                    raise OSError("simulated installation failure")
                return original_replace(source, target)

            with patch("model_bundle.os.replace", side_effect=fail_manifest), patch(
                "model_bundle.shutil.rmtree", side_effect=OSError("simulated cleanup failure")
            ):
                with self.assertRaises(BundleInstallError) as raised:
                    install_bundle(staging, destination, ["model.onnx"])
            error = raised.exception
            backup = error.backup_paths["backup"]
            self.assertEqual(len(error.errors), 2)
            self.assertIn("simulated installation failure", str(error))
            self.assertIn("simulated cleanup failure", str(error))
            self.assertEqual((destination / "model.onnx").read_text(), "old model")
            self.assertEqual((destination / "manifest.json").read_text(), "old manifest")
            self.assertTrue(backup.is_dir())


if __name__ == "__main__":
    unittest.main()
