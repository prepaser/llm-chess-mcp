import os
from pathlib import Path, PurePosixPath
import shutil
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


class BundleInstallError(OSError):
    def __init__(self, message, errors, backup_paths=None):
        super().__init__(message)
        self.errors = tuple(errors)
        self.backup_paths = dict(backup_paths or {})


def _backup_error(primary, restore_errors, backup_paths):
    details = [f"bundle installation failed: {primary}"]
    if restore_errors:
        details.append("rollback errors: " + "; ".join(
            f"{name}: {error}" for name, error in restore_errors))
    if backup_paths:
        details.append("recoverable backups: " + "; ".join(
            f"{name}={path}" for name, path in backup_paths.items()))
    errors = [primary, *(error for _, error in restore_errors)]
    return BundleInstallError("; ".join(details), errors, backup_paths)


def install_bundle(staging, destination, names):
    names = [*names, "manifest.json"]
    if len(names) != len(set(names)):
        raise ValueError("duplicate bundle files")
    paths = [(safe_path(staging, name), safe_path(destination, name)) for name in names]
    for source, target in paths:
        if not source.is_file() or (target.exists() and not target.is_file()):
            raise ValueError(f"invalid bundle file: {target}")

    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix=".maia-backup-", dir=destination.parent)).resolve()
    replaced = []
    try:
        for source, target in paths:
            target.parent.mkdir(parents=True, exist_ok=True)
            name = str(target.relative_to(destination))
            previous = backup / name
            existed = target.exists()
            if existed:
                previous.parent.mkdir(parents=True, exist_ok=True)
                os.replace(target, previous)
            replaced.append((target, previous, existed, name))
            os.replace(source, target)
    except BaseException as primary:
        restore_errors = []
        recoverable = {}
        for target, previous, existed, name in reversed(replaced):
            if existed:
                try:
                    os.replace(previous, target)
                except BaseException as error:
                    restore_errors.append((name, error))
                    recoverable[name] = previous
            else:
                try:
                    target.unlink(missing_ok=True)
                except BaseException as error:
                    restore_errors.append((name, error))
        if restore_errors:
            raise _backup_error(primary, restore_errors, recoverable) from primary
        try:
            shutil.rmtree(backup)
        except BaseException as cleanup_error:
            raise _backup_error(primary, [("backup", cleanup_error)], {"backup": backup}) from primary
        raise
    try:
        shutil.rmtree(backup)
    except BaseException as cleanup_error:
        raise BundleInstallError(
            f"bundle installed but backup cleanup failed: {cleanup_error}; "
            f"recoverable backup: {backup}", [cleanup_error], {"backup": backup}) from cleanup_error
