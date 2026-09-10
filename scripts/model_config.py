import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL_KEYS = {"3m", "5m", "23m", "79m"}
ANALYSIS_MODES = {"both", "stockfish", "lc0"}
LC0_BACKENDS = {"cpu", "cuda"}
LC0_PLATFORMS = {"linux-x64", "win32-x64"}
STOCKFISH_FLAVORS = {
    "full", "lite", "single", "lite-single", "single-lite", "asm",
}
STOCKFISH_VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
LC0_VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\Z")


def read_config(path=None):
    path = Path(path or ROOT / "model.config.json").resolve()
    root = json.loads(path.read_text())
    if not isinstance(root, dict) or set(root) != {"schemaVersion", "analysis", "maia3", "stockfish", "lc0"}:
        raise ValueError("invalid model configuration fields")
    if type(root["schemaVersion"]) is not int or root["schemaVersion"] != 3:
        raise ValueError("unsupported model configuration version")

    analysis = root["analysis"]
    if (not isinstance(analysis, dict) or set(analysis) != {"mode"}
            or not isinstance(analysis["mode"], str) or analysis["mode"] not in ANALYSIS_MODES):
        raise ValueError("invalid analysis configuration")

    maia = root["maia3"]
    if not isinstance(maia, dict) or set(maia) != {"model", "source"}:
        raise ValueError("invalid Maia3 configuration fields")
    if not isinstance(maia["model"], str) or maia["model"] not in MODEL_KEYS:
        raise ValueError("unsupported Maia3 model")
    source = maia["source"]
    if not isinstance(source, dict):
        raise ValueError("invalid model source")
    fields = {"type", "repoId", "filename", "revision"} if source.get("type") == "huggingface" else {"type", "path"}
    if set(source) != fields or any(not isinstance(v, str) or not v.strip() or "\0" in v for v in source.values()):
        raise ValueError("invalid model source fields")
    if source["type"] == "huggingface":
        if not re.fullmatch(r"[0-9a-f]{40}", source["revision"]):
            raise ValueError("model revision must be a full lowercase commit SHA")
    elif source["type"] != "local":
        raise ValueError("unsupported model source")

    stockfish = root["stockfish"]
    if not isinstance(stockfish, dict) or set(stockfish) != {"version", "flavor"}:
        raise ValueError("invalid Stockfish configuration fields")
    version = stockfish["version"]
    if not isinstance(version, str) or not STOCKFISH_VERSION.fullmatch(version):
        raise ValueError("Stockfish version must be an exact stable x.y.z version")
    flavor = stockfish["flavor"]
    if not isinstance(flavor, str) or flavor not in STOCKFISH_FLAVORS:
        raise ValueError("unsupported Stockfish flavor")

    lc0 = root["lc0"]
    if not isinstance(lc0, dict) or set(lc0) != {"version", "weights", "backend", "platforms"}:
        raise ValueError("invalid Lc0 configuration fields")
    if (not isinstance(lc0["version"], str) or lc0["version"].strip() != lc0["version"]
            or not LC0_VERSION.fullmatch(lc0["version"])):
        raise ValueError("Lc0 version must be an exact stable x.y.z version")
    if not isinstance(lc0["backend"], str) or lc0["backend"] not in LC0_BACKENDS:
        raise ValueError("unsupported Lc0 backend")
    platforms = lc0["platforms"]
    if (not isinstance(platforms, list) or not platforms
            or any(not isinstance(platform, str) for platform in platforms)
            or len(set(platforms)) != len(platforms)
            or any(platform not in LC0_PLATFORMS for platform in platforms)):
        raise ValueError("unsupported Lc0 platforms")
    weights = lc0["weights"]
    if not isinstance(weights, dict) or set(weights) != {"url", "sha256"}:
        raise ValueError("invalid Lc0 weights fields")
    if (not isinstance(weights["url"], str) or weights["url"].strip() != weights["url"]
            or not weights["url"].startswith("https://")
            or not weights["url"].strip() or "\0" in weights["url"]):
        raise ValueError("Lc0 weights URL must be an HTTPS URL")
    if not isinstance(weights["sha256"], str) or not SHA256.fullmatch(weights["sha256"]):
        raise ValueError("Lc0 weights SHA-256 must be a lowercase digest")

    config = {
        "schemaVersion": 1,
        "model": maia["model"],
        "source": source,
    }
    return config, path


def checkpoint_path(config, config_path, cache_dir=None):
    source = config["source"]
    if source["type"] == "local":
        path = (Path(config_path).parent / source["path"]).resolve()
        if not path.is_file():
            raise ValueError(f"checkpoint not found: {path}")
        return path
    from huggingface_hub import hf_hub_download
    return Path(hf_hub_download(
        repo_id=source["repoId"], filename=source["filename"],
        revision=source["revision"], cache_dir=cache_dir,
    ))


def sha256(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def load_checkpoint(path, device):
    import torch
    checkpoint = torch.load(path, map_location=device, weights_only=True)
    if isinstance(checkpoint, dict) and "model_state_dict" in checkpoint:
        checkpoint = checkpoint["model_state_dict"]
    if not isinstance(checkpoint, dict):
        raise ValueError("checkpoint must contain a state dictionary")
    renamed = {key.replace("smolgen", "gab"): value for key, value in checkpoint.items()}
    if len(renamed) != len(checkpoint):
        raise ValueError("checkpoint has duplicate normalized keys")
    return renamed
