#!/usr/bin/env python3
"""Regression-test the exported ONNX model against the upstream Maia3.

Compares top-k move agreement and max probability error across fixed FENs and
Elo pairs. Run from the repo root:

    .venv-maia3/bin/python scripts/verify_maia3.py

Requires the maia3 package (for the reference implementation) and onnxruntime.
"""

import argparse
import json
import sys

import chess
import numpy as np
import onnxruntime as ort
import torch

from maia3.dataset import get_historical_tokens, get_legal_moves_mask, tokenize_board
from maia3.models import MAIA3Model
from maia3.model_registry import MODEL_SPECS, apply_model_config
from maia3.utils import get_all_possible_moves, mirror_move
from model_config import ROOT, checkpoint_path, load_checkpoint, read_config, sha256
from model_bundle import safe_path

FENS = [
    chess.STARTING_FEN,
    "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
    "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4",
    "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1",
    "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 2 3",
]

ELO_PAIRS = [(800, 800), (1200, 1200), (1500, 1500), (1500, 2200), (2200, 1500)]


def build_reference(config, checkpoint, device="cpu"):
    spec = next(s for s in MODEL_SPECS if s.name == f"maia3-{config['model']}")
    cfg = argparse.Namespace()
    apply_model_config(cfg, spec)
    cfg.device = device
    cfg.checkpoint_path = str(checkpoint)
    model = MAIA3Model(cfg).to(device)
    model.load_state_dict(load_checkpoint(cfg.checkpoint_path, device), strict=True)
    model.eval()
    return model, cfg


def historical_tokens(board, cfg):
    replay = board.root()
    hist = [tokenize_board(replay)]
    for mv in board.move_stack:
        replay.push(mv)
        hist.append(tokenize_board(replay))
    return get_historical_tokens(
        hist, cfg, base=0.0, inc=0.0, clk_left_before=0.0, clk_ponder=0.0
    )


def verification_boards():
    boards = [chess.Board(fen) for fen in FENS]
    board = chess.Board("8/8/8/8/8/8/7k/K7 w - - 0 1")
    for move in ("Ka2", "Kg3", "Kb3"):
        board.push_san(move)
    boards.append(board)
    return boards


def reference_probs(model, cfg, board, self_elo, oppo_elo, device="cpu"):
    all_moves = get_all_possible_moves()
    all_moves_dict = {m: i for i, m in enumerate(all_moves)}
    legal_mask = get_legal_moves_mask(board, all_moves_dict)

    tokens = historical_tokens(board, cfg).unsqueeze(0).to(device)
    self_elos = torch.tensor([self_elo], dtype=torch.long, device=device)
    oppo_elos = torch.tensor([oppo_elo], dtype=torch.long, device=device)
    with torch.no_grad():
        logits_move, _, _ = model(tokens, self_elos, oppo_elos)
    logits = logits_move[0].float()
    logits = logits.masked_fill(~legal_mask.to(device), float("-inf"))
    probs = torch.softmax(logits, dim=-1).cpu().numpy()

    result = {}
    for mv in board.legal_moves:
        uci = mv.uci() if board.turn == chess.WHITE else mirror_move(mv.uci())
        result[mv.uci()] = float(probs[all_moves_dict[uci]])
    return result


def onnx_probs(session, board, self_elo, oppo_elo):
    cfg = argparse.Namespace(history=8, use_padding=True, include_time_info=False)
    tokens = historical_tokens(board, cfg)[:, : 12 * 8].unsqueeze(0).numpy().astype(np.float32)

    feeds = {
        "tokens": tokens,
        "self_elo": np.array([self_elo], dtype=np.int64),
        "oppo_elo": np.array([oppo_elo], dtype=np.int64),
    }
    logits = session.run(None, feeds)[0][0]

    all_moves = get_all_possible_moves()
    all_moves_dict = {m: i for i, m in enumerate(all_moves)}
    legal_mask = get_legal_moves_mask(board, all_moves_dict).numpy()
    logits = np.where(legal_mask, logits, -np.inf)
    probs = np.exp(logits - logits.max())
    probs /= probs.sum()

    result = {}
    for mv in board.legal_moves:
        uci = mv.uci() if board.turn == chess.WHITE else mirror_move(mv.uci())
        result[mv.uci()] = float(probs[all_moves_dict[uci]])
    return result


def compare_probs(ref, onx, top_k):
    if any(not np.isfinite(value) for probs in (ref, onx) for value in probs.values()):
        raise ValueError("non-finite move probabilities")
    ref_sorted = sorted(ref.items(), key=lambda x: -x[1])
    onx_sorted = sorted(onx.items(), key=lambda x: -x[1])
    ref_topk = {m for m, _ in ref_sorted[:top_k]}
    onx_topk = {m for m, _ in onx_sorted[:top_k]}
    max_err = max(abs(ref[m] - onx[m]) for m in ref)
    max_kl = max(
        max(ref[m], 1e-12) * np.log(max(ref[m], 1e-12) / max(onx[m], 1e-12))
        for m in ref
    )
    return ref_sorted[0][0] == onx_sorted[0][0], ref_topk == onx_topk, max_err, max_kl


def verify_model(config, checkpoint, onnx_path, device="cpu", top_k=5, max_prob_err=1e-3):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    session = ort.InferenceSession(str(onnx_path), sess_options=options, providers=["CPUExecutionProvider"])
    model, cfg = build_reference(config, checkpoint, device)

    total = 0
    top1_agree = 0
    topk_agree = 0
    max_err = 0.0
    max_kl = 0.0

    for board in verification_boards():
        for self_elo, oppo_elo in ELO_PAIRS:
            ref = reference_probs(model, cfg, board, self_elo, oppo_elo, device)
            onx = onnx_probs(session, board, self_elo, oppo_elo)
            top1, topk, err, kl = compare_probs(ref, onx, top_k)
            top1_agree += top1
            topk_agree += topk
            max_err = max(max_err, err)
            max_kl = max(max_kl, kl)

            total += 1

    print(f"positions x elo pairs: {total}")
    print(f"top-1 agreement: {top1_agree}/{total} ({100 * top1_agree / total:.1f}%)")
    print(f"top-{top_k} agreement: {topk_agree}/{total} ({100 * topk_agree / total:.1f}%)")
    print(f"max probability error: {max_err:.6e}")
    print(f"max KL contribution: {max_kl:.6e}")

    ok = (
        top1_agree == total
        and topk_agree == total
        and np.isfinite(max_err)
        and max_err < max_prob_err
    )
    print("PASS" if ok else "FAIL")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=None)
    ap.add_argument("--onnx", default=None)
    ap.add_argument("--cache-dir", default=None)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--top-k", type=int, default=5)
    ap.add_argument("--max-prob-err", type=float, default=1e-3)
    args = ap.parse_args()
    config, config_path = read_config(args.config)
    checkpoint = checkpoint_path(config, config_path, args.cache_dir)
    if args.onnx:
        onnx_path = args.onnx
    else:
        manifest = json.loads((ROOT / "models" / "manifest.json").read_text())
        if manifest.get("schemaVersion") != 1 or manifest.get("config") != config:
            raise ValueError("bundle manifest does not match model configuration")
        if manifest.get("checkpointSha256") != sha256(checkpoint):
            raise ValueError("checkpoint does not match bundle manifest")
        onnx_path = safe_path(ROOT / "models", manifest.get("modelFile"))
    ok = verify_model(config, checkpoint, onnx_path, args.device, args.top_k, args.max_prob_err)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
