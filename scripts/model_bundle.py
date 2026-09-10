import os
from pathlib import Path, PurePosixPath
import tempfile

from model_config import sha256


def safe_path(root, name):
    if not isinstance(name, str) or not name or "\\" in name or ":" in name:
        raise ValueError(f"invalid model file path: {name}")
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts) or PurePosixPath(name).is_absolute():
        raise ValueError(f"invalid model file path: {name}")
    path = Path(root) / name
    if not path.resolve().is_relative_to(Path(root).resolve()):
        raise ValueError(f"model file escapes bundle: {name}")
    return path


def bundle_files(model_path):
    import onnx

    model_path = Path(model_path)
    model = onnx.load(model_path, load_external_data=False)
    names = {model_path.name}

    def collect(message):
        if isinstance(message, onnx.TensorProto):
            if message.data_location == onnx.TensorProto.EXTERNAL:
                locations = [entry.value for entry in message.external_data if entry.key == "location"]
                if len(locations) != 1 or locations[0] in (model_path.name, "manifest.json"):
                    raise ValueError("invalid ONNX external data location")
                names.add(locations[0])
            return
        for field, value in message.ListFields():
            if field.message_type is not None:
                for child in value if field.is_repeated else [value]:
                    collect(child)

    collect(model)
    return [{"path": name, "sha256": sha256(safe_path(model_path.parent, name))}
            for name in sorted(names)]


def install_bundle(staging, destination, names):
    names = [*names, "manifest.json"]
    if len(names) != len(set(names)):
        raise ValueError("duplicate bundle files")
    paths = [(safe_path(staging, name), safe_path(destination, name)) for name in names]
    for source, target in paths:
        if not source.is_file() or (target.exists() and not target.is_file()):
            raise ValueError(f"invalid bundle file: {target}")
    with tempfile.TemporaryDirectory(prefix=".maia-backup-", dir=staging) as backup:
        replaced = []
        try:
            for index, (source, target) in enumerate(paths):
                target.parent.mkdir(parents=True, exist_ok=True)
                previous = Path(backup) / str(index)
                existed = target.exists()
                if existed:
                    os.replace(target, previous)
                replaced.append((target, previous, existed))
                os.replace(source, target)
        except BaseException:
            for target, previous, existed in reversed(replaced):
                if existed:
                    os.replace(previous, target)
                else:
                    target.unlink(missing_ok=True)
            raise
