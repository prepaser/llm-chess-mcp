#!/usr/bin/env python3
"""Regression-test the exported ONNX model against the upstream Maia3.

Compares top-k move agreement and max probability error across fixed FENs and
Elo pairs. Run from the repo root:

    .venv-maia3/bin/python scripts/verify_maia3.py --model 5m

Requires the maia3 package (for the reference implementation) and onnxruntime.
"""

import argparse
import sys

import chess
import numpy as np
import onnxruntime as ort
import torch

from maia3.dataset import get_historical_tokens, get_legal_moves_mask, tokenize_board
from maia3.models import MAIA3Model
from maia3.model_registry import MODEL_SPECS, apply_model_config
from maia3.utils import get_all_possible_moves, mirror_move

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


def build_reference(model_key, device="cpu"):
    spec = next(s for s in MODEL_SPECS if s.name == f"maia3-{model_key}")
    cfg = argparse.Namespace()
    apply_model_config(cfg, spec)
    cfg.device = device
    from maia3.model_registry import resolve_checkpoint_path
    cfg.checkpoint_path = resolve_checkpoint_path(spec)
    model = MAIA3Model(cfg).to(device)
    ckpt = torch.load(cfg.checkpoint_path, map_location=device, weights_only=True)
    sd = ckpt["model_state_dict"] if "model_state_dict" in ckpt else ckpt
    model.load_state_dict({k.replace("smolgen", "gab"): v for k, v in sd.items()}, strict=False)
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
    logits = logits.masked_fill(~legal_mask, float("-inf"))
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="5m", choices=["3m", "5m", "23m", "79m"])
    ap.add_argument("--onnx", default=None)
    ap.add_argument("--top-k", type=int, default=5)
    ap.add_argument("--max-prob-err", type=float, default=1e-3)
    args = ap.parse_args()

    onnx_path = args.onnx or f"models/maia3-{args.model}.onnx"
    session = ort.InferenceSession(onnx_path)
    model, cfg = build_reference(args.model)

    total = 0
    top1_agree = 0
    topk_agree = 0
    max_err = 0.0
    max_kl = 0.0

    for board in verification_boards():
        for self_elo, oppo_elo in ELO_PAIRS:
            ref = reference_probs(model, cfg, board, self_elo, oppo_elo)
            onx = onnx_probs(session, board, self_elo, oppo_elo)
            top1, topk, err, kl = compare_probs(ref, onx, args.top_k)
            top1_agree += top1
            topk_agree += topk
            max_err = max(max_err, err)
            max_kl = max(max_kl, kl)

            total += 1

    print(f"positions x elo pairs: {total}")
    print(f"top-1 agreement: {top1_agree}/{total} ({100 * top1_agree / total:.1f}%)")
    print(f"top-{args.top_k} agreement: {topk_agree}/{total} ({100 * topk_agree / total:.1f}%)")
    print(f"max probability error: {max_err:.6e}")
    print(f"max KL contribution: {max_kl:.6e}")

    ok = (
        top1_agree == total
        and topk_agree == total
        and max_err < args.max_prob_err
    )
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
