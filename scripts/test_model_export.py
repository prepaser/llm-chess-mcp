import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import onnx
import torch

import export_maia3
from model_bundle import bundle_files


class ModelExportTests(unittest.TestCase):
    def test_external_data_files_are_read_from_onnx(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tensor = onnx.helper.make_tensor("weights", onnx.TensorProto.FLOAT, [1], [1.0])
            tensor.ClearField("float_data")
            tensor.data_location = onnx.TensorProto.EXTERNAL
            entry = tensor.external_data.add()
            entry.key, entry.value = "location", "weights.bin"
            graph = onnx.helper.make_graph([], "fixture", [], [], [tensor])
            model = onnx.helper.make_model(graph)
            path = root / "fixture.onnx"
            path.write_bytes(model.SerializeToString())
            (root / "weights.bin").write_bytes(b"data")
            self.assertEqual([item["path"] for item in bundle_files(path)], ["fixture.onnx", "weights.bin"])
            entry.value = "../escape.bin"
            model.graph.initializer[0].external_data[0].value = "../escape.bin"
            path.write_bytes(model.SerializeToString())
            with self.assertRaises(ValueError):
                bundle_files(path)

    def test_incompatible_checkpoint_preserves_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "models").mkdir()
            manifest = root / "models" / "manifest.json"
            manifest.write_text("existing bundle")
            torch.save({"unexpected": torch.zeros(1)}, root / "checkpoint.pt")
            config = {
                "schemaVersion": 3,
                "analysis": {"mode": "both"},
                "maia3": {"model": "5m", "source": {"type": "local", "path": "checkpoint.pt"}},
                "stockfish": {"version": "18.0.8", "flavor": "lite-single"},
                "lc0": {"version": "0.32.1", "weights": {"url": "https://example.invalid/weights.pb.gz", "sha256": "a" * 64}, "backend": "cpu", "platforms": ["linux-x64"]},
            }
            path = root / "model.config.json"
            path.write_text(json.dumps(config))
            with patch.object(export_maia3, "ROOT", root), patch("sys.argv", ["export", "--config", str(path)]):
                with self.assertRaisesRegex(RuntimeError, "Missing key"):
                    export_maia3.main()
            self.assertEqual(manifest.read_text(), "existing bundle")

    def test_failed_export_preserves_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "models").mkdir()
            manifest = root / "models" / "manifest.json"
            manifest.write_text("existing bundle")
            config = {
                "schemaVersion": 3,
                "analysis": {"mode": "both"},
                "maia3": {"model": "3m", "source": {"type": "local", "path": "checkpoint.pt"}},
                "stockfish": {"version": "18.0.8", "flavor": "lite-single"},
                "lc0": {"version": "0.32.1", "weights": {"url": "https://example.invalid/weights.pb.gz", "sha256": "a" * 64}, "backend": "cpu", "platforms": ["linux-x64"]},
            }
            path = root / "model.config.json"
            path.write_text(json.dumps(config))
            (root / "checkpoint.pt").write_bytes(b"fixture")
            with (
                patch.object(export_maia3, "ROOT", root),
                patch("sys.argv", ["export", "--config", str(path)]),
                patch.object(export_maia3, "load_checkpoint", return_value={}),
                patch.object(export_maia3, "MAIA3Model"),
                patch.object(export_maia3, "verify_against_original"),
                patch.object(export_maia3, "export", side_effect=RuntimeError("export failed")),
            ):
                with self.assertRaisesRegex(RuntimeError, "export failed"):
                    export_maia3.main()
            self.assertEqual(manifest.read_text(), "existing bundle")
            self.assertFalse(list(root.glob(".maia-export-*")))


if __name__ == "__main__":
    unittest.main()
