#!/usr/bin/env python3
"""Export Maia3 to ONNX for onnxruntime-node.

Reimplements the Chessformer model with ONNX-friendly ops (manual attention,
manual RMSNorm, explicit GELU) while keeping state-dict keys identical to the
original so the released checkpoint loads directly. Optionally verifies logits
against the original maia3 package before exporting.

Usage:
    python scripts/export_maia3.py --model 5m --out models/maia3-5m.onnx
"""

import argparse
import math
import sys

import torch
import torch.nn as nn
import torch.nn.functional as F

# ---------------------------------------------------------------------------
# Model configs (mirrors maia3/model_registry.py)
# ---------------------------------------------------------------------------

BASE = dict(
    history=8,
    use_padding=True,
    include_time_info=False,
    dim_emb=128,
    num_blocks=8,
    mlp_ratio=2.0,
    dropout=0.0,
    use_gab=True,
    use_relative_bias=False,
    use_absolute_pe=False,
    use_rms_norm=True,
    omit_qkv_biases=True,
    activation="gelu",
)

MODELS = {
    "3m": dict(BASE, dim_vit=192, head_hid_dim=192, num_heads=6,
               gab_gen_size=64, gab_per_square_dim=0, gab_intermediate_dim=64),
    "5m": dict(BASE, dim_vit=256, head_hid_dim=256, num_heads=8,
               gab_gen_size=64, gab_per_square_dim=0, gab_intermediate_dim=64),
    "23m": dict(BASE, dim_vit=512, head_hid_dim=512, num_heads=16,
                gab_gen_size=128, gab_per_square_dim=32, gab_intermediate_dim=128),
    "79m": dict(BASE, dim_vit=1024, head_hid_dim=1024, num_heads=32,
                gab_gen_size=128, gab_per_square_dim=32, gab_intermediate_dim=128),
}

class Cfg:
    def __init__(self, d):
        self.__dict__.update(d)


# ---------------------------------------------------------------------------
# ONNX-friendly reimplementation
# ---------------------------------------------------------------------------

def gelu(x):
    return 0.5 * x * (1.0 + torch.erf(x / math.sqrt(2.0)))


class RMSNorm(nn.Module):
    def __init__(self, dim, eps=1e-5):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(dim))

    def forward(self, x):
        rms = torch.sqrt(torch.mean(x * x, dim=-1, keepdim=True) + self.eps)
        return x / rms * self.weight


class ManualMHA(nn.Module):
    """Drop-in for nn.MultiheadAttention (batch_first, additive attn bias).

    nn.MultiheadAttention's `bias` flag controls BOTH in_proj_bias and out_proj
    bias. We mirror that exactly so state-dict keys match.
    """

    def __init__(self, d_model, nhead, dropout=0.0, bias=False):
        super().__init__()
        self.d_model = d_model
        self.nhead = nhead
        self.head_dim = d_model // nhead
        self.in_proj_weight = nn.Parameter(torch.empty(3 * d_model, d_model))
        if bias:
            self.in_proj_bias = nn.Parameter(torch.empty(3 * d_model))
        else:
            self.register_parameter("in_proj_bias", None)
        self.out_proj = nn.Linear(d_model, d_model, bias=bias)
        nn.init.xavier_uniform_(self.in_proj_weight)
        nn.init.xavier_uniform_(self.out_proj.weight)
        if bias:
            nn.init.zeros_(self.out_proj.bias)

    def forward(self, query, key, value, attn_bias):
        B, T, E = query.shape
        H, D = self.nhead, self.head_dim
        qkv = F.linear(query, self.in_proj_weight, self.in_proj_bias)
        q, k, v = qkv.chunk(3, dim=-1)
        q = q.view(B, T, H, D).transpose(1, 2)
        k = k.view(B, T, H, D).transpose(1, 2)
        v = v.view(B, T, H, D).transpose(1, 2)
        scores = (q @ k.transpose(-2, -1)) / math.sqrt(D)
        scores = scores + attn_bias
        attn = torch.softmax(scores, dim=-1)
        out = attn @ v
        out = out.transpose(1, 2).contiguous().view(B, T, E)
        return self.out_proj(out)


class MHA(nn.Module):
    def __init__(self, cfg, d_model, nhead, dropout, gab_weight):
        super().__init__()
        self.use_gab = cfg.use_gab
        self.use_relative_bias = cfg.use_relative_bias
        self.mha = ManualMHA(d_model, nhead, dropout, bias=not cfg.omit_qkv_biases)
        self.num_heads = nhead
        self.gen_size = cfg.gab_gen_size
        if cfg.use_gab:
            self.gab_weight = gab_weight
            if cfg.gab_per_square_dim == 0:
                self.sm1 = None
                self.sm2 = nn.Linear(d_model, cfg.gab_intermediate_dim)
            else:
                self.sm1 = nn.Linear(d_model, cfg.gab_per_square_dim)
                self.sm2 = nn.Linear(64 * cfg.gab_per_square_dim, cfg.gab_intermediate_dim)
            self.ln1 = nn.LayerNorm(cfg.gab_intermediate_dim)
            self.sm3 = nn.Linear(cfg.gab_intermediate_dim, nhead * cfg.gab_gen_size)
            self.ln2 = nn.LayerNorm(nhead * cfg.gab_gen_size)
            self.sm_act = nn.GELU()

    def _sq_bias(self, x):
        B = x.size(0)
        if self.sm1 is not None:
            y = self.sm1(x).reshape(B, -1)
            y = self.sm_act(self.sm2(y))
        else:
            y = self.sm_act(self.sm2(torch.mean(x, dim=1)))
        y = self.ln1(y)
        y = self.sm_act(self.sm3(y))
        y = self.ln2(y).view(B, self.num_heads, self.gen_size)
        b = torch.matmul(y, self.gab_weight.t())
        return b.view(B, self.num_heads, 64, 64)

    def forward(self, query):
        if not self.use_gab and not self.use_relative_bias:
            return self.mha(query, query, query, None)
        bias = self._sq_bias(query)
        return self.mha(query, query, query, bias)


class EncoderOnlyBlock(nn.Module):
    def __init__(self, cfg, d_model, nhead, dim_feedforward, dropout, gab_weight):
        super().__init__()
        self.self_attn = MHA(cfg, d_model, nhead, dropout, gab_weight)
        self.linear1 = nn.Linear(d_model, dim_feedforward)
        self.dropout = nn.Dropout(dropout)
        self.linear2 = nn.Linear(dim_feedforward, d_model)
        norm_cls = RMSNorm if cfg.use_rms_norm else nn.LayerNorm
        self.norm1 = norm_cls(d_model)
        self.norm2 = norm_cls(d_model)
        self.dropout1 = nn.Dropout(dropout)
        self.dropout2 = nn.Dropout(dropout)
        self.activation = gelu if cfg.activation.lower() == "gelu" else F.relu

    def forward(self, x):
        sa_out = self.self_attn(x)
        x = self.norm1(x + self.dropout1(sa_out))
        ff_out = self.linear2(self.dropout(self.activation(self.linear1(x))))
        x = self.norm2(x + self.dropout2(ff_out))
        return x


class CustomTransformerEncoder(nn.Module):
    def __init__(self, cfg, dim, depth, heads, mlp_dim, dropout, gab_weight):
        super().__init__()
        self.layers = nn.ModuleList(
            [EncoderOnlyBlock(cfg, dim, heads, mlp_dim, dropout, gab_weight)
             for _ in range(depth)]
        )
        self.norm = nn.LayerNorm(dim)

    def forward(self, x):
        for blk in self.layers:
            x = blk(x)
        return self.norm(x)


class MAIA3Model(nn.Module):
    def __init__(self, cfg):
        super().__init__()
        self.cfg = cfg
        self.elo_embedding_low = nn.Embedding(1, cfg.dim_emb)
        self.elo_embedding_high = nn.Embedding(1, cfg.dim_emb)
        time_info_dims = 4 if cfg.include_time_info else 1
        self.token_projection = nn.Linear(
            12 * cfg.history + time_info_dims - 1 + 2 * cfg.dim_emb, cfg.dim_vit
        )
        if cfg.use_gab:
            self.gab_shared_weight = nn.Parameter(torch.empty(64 * 64, cfg.gab_gen_size))
        else:
            self.gab_shared_weight = None
        self.transformer = CustomTransformerEncoder(
            cfg, cfg.dim_vit, cfg.num_blocks, cfg.num_heads,
            int(cfg.dim_vit * cfg.mlp_ratio), cfg.dropout, self.gab_shared_weight,
        )
        self.last_ln = nn.LayerNorm(cfg.dim_vit)
        self.fc_value_hid = nn.Linear(cfg.dim_vit, cfg.head_hid_dim)
        self.fc_value = nn.Linear(cfg.head_hid_dim, 3)
        self.fc_ponder_hid = nn.Linear(cfg.dim_vit, cfg.head_hid_dim)
        self.fc_ponder = nn.Linear(cfg.head_hid_dim, 1)
        self.proj_sq_from = nn.Linear(cfg.dim_vit, cfg.head_hid_dim, bias=False)
        self.proj_sq_to = nn.Linear(cfg.dim_vit, cfg.head_hid_dim, bias=False)
        self.promo_bias_proj = nn.Linear(cfg.head_hid_dim, 4, bias=False)

    def interpolate_elo(self, elos):
        upper = 5000.0
        elos = torch.clamp(elos.float(), 0.0, upper)
        w_low = elos / upper
        w_high = 1.0 - w_low
        low = self.elo_embedding_low.weight
        high = self.elo_embedding_high.weight
        return w_low.unsqueeze(1) * low + w_high.unsqueeze(1) * high

    def forward(self, tokens, self_elos, oppo_elos):
        if self.cfg.include_time_info:
            tokens = tokens[:, :, : 12 * self.cfg.history + 3]
        else:
            tokens = tokens[:, :, : 12 * self.cfg.history]

        self_elo_embs = self.interpolate_elo(self_elos).unsqueeze(1).expand(-1, 64, -1)
        oppo_elo_embs = self.interpolate_elo(oppo_elos).unsqueeze(1).expand(-1, 64, -1)
        embs = torch.cat([tokens, self_elo_embs, oppo_elo_embs], dim=-1)
        x = self.token_projection(embs)
        x = self.transformer(x)

        sq_from = self.proj_sq_from(x[:, :64, :])
        sq_to = self.proj_sq_to(x[:, :64, :])
        scores_base = torch.matmul(sq_from, sq_to.transpose(1, 2)) / math.sqrt(self.cfg.head_hid_dim)
        scores_flat = scores_base.reshape(x.size(0), 64 * 64)

        rank7 = [6 * 8 + f for f in range(8)]
        rank8 = [7 * 8 + f for f in range(8)]
        rank8_features = sq_to[:, rank8, :]
        promo_biases = self.promo_bias_proj(rank8_features) * math.sqrt(self.cfg.head_hid_dim)

        promotion_logits = []
        for from_file in range(8):
            from_sq = rank7[from_file]
            for to_file in range(8):
                to_sq = rank8[to_file]
                base = scores_base[:, from_sq, to_sq]
                for piece_idx in range(4):
                    promotion_logits.append((base + promo_biases[:, to_file, piece_idx]).unsqueeze(1))
        promotion_logits = torch.cat(promotion_logits, dim=1)
        logits_move = torch.cat([scores_flat, promotion_logits], dim=1)

        x = self.last_ln(x.mean(dim=1))
        logits_value = self.fc_value(F.relu(self.fc_value_hid(x)))
        logits_ponder = self.fc_ponder(F.relu(self.fc_ponder_hid(x)))
        return logits_move, logits_value, logits_ponder.squeeze(1)


# ---------------------------------------------------------------------------
# Checkpoint loading
# ---------------------------------------------------------------------------

def load_checkpoint(path, device):
    ckpt = torch.load(path, map_location=device, weights_only=True)
    if isinstance(ckpt, dict) and "model_state_dict" in ckpt:
        ckpt = ckpt["model_state_dict"]
    return {k.replace("smolgen", "gab"): v for k, v in ckpt.items()}


def download_checkpoint(model_key, cache_dir):
    from huggingface_hub import hf_hub_download
    if model_key == "3m":
        return hf_hub_download(
            repo_id="UofTCSSLab/Maia3-ablate-3M", filename="maia3-3m.pt",
            revision="990dfd78e6403805dbbbb5fcfccd4b3d3e778cc1", cache_dir=cache_dir,
        )
    if model_key == "5m":
        return hf_hub_download(
            repo_id="UofTCSSLab/Maia3-5M", filename="maia3-5m.pt",
            revision="b6559de2398d7140b985f28fd2c19fb5e47ddabe", cache_dir=cache_dir,
        )
    if model_key == "23m":
        return hf_hub_download(
            repo_id="UofTCSSLab/Maia3-23M", filename="maia3-23m.pt",
            revision="51a0145a8178046f7de23119160b136672deeb2b", cache_dir=cache_dir,
        )
    return hf_hub_download(
        repo_id="UofTCSSLab/Maia3-79M", filename="maia3-79m.pt",
        revision="a107d6ceb7b298cb04ae1da4edffe2939858b894", cache_dir=cache_dir,
    )


# ---------------------------------------------------------------------------
# Verification against original maia3
# ---------------------------------------------------------------------------

def verify_against_original(cfg, state_dict, device):
    try:
        from maia3.models import MAIA3Model as OrigModel
    except ImportError:
        print("maia3 not installed; skipping verification", file=sys.stderr)
        return

    orig = OrigModel(cfg).to(device)
    renamed = {k.replace("smolgen", "gab"): v for k, v in state_dict.items()}
    orig.load_state_dict(renamed, strict=False)
    orig.eval()

    mine = MAIA3Model(cfg).to(device)
    mine.load_state_dict(state_dict, strict=False)
    mine.eval()

    tokens = torch.randn(1, 64, 12 * cfg.history, device=device)
    self_elo = torch.tensor([1500], dtype=torch.long, device=device)
    oppo_elo = torch.tensor([1800], dtype=torch.long, device=device)

    with torch.no_grad():
        o_move, o_val, o_pond = orig(tokens, self_elo, oppo_elo)
        m_move, m_val, m_pond = mine(tokens, self_elo, oppo_elo)

    for name, a, b in [
        ("logits_move", o_move, m_move),
        ("logits_value", o_val, m_val),
        ("logits_ponder", o_pond, m_pond),
    ]:
        diff = (a - b).abs().max().item()
        print(f"  {name}: max abs diff = {diff:.6e}")
        if diff > 1e-3:
            raise SystemExit(f"VERIFICATION FAILED for {name}: {diff}")


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def export(cfg, model, out_path, device):
    model.eval()
    tokens = torch.randn(1, 64, 12 * cfg.history, device=device)
    self_elo = torch.tensor([1500], dtype=torch.long, device=device)
    oppo_elo = torch.tensor([1800], dtype=torch.long, device=device)

    torch.onnx.export(
        model,
        (tokens, self_elo, oppo_elo),
        out_path,
        input_names=["tokens", "self_elo", "oppo_elo"],
        output_names=["logits_move", "logits_value", "logits_ponder"],
        opset_version=17,
        do_constant_folding=True,
        dynamic_axes=None,
    )
    print(f"exported {out_path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="5m", choices=list(MODELS))
    ap.add_argument("--out", default=None)
    ap.add_argument("--checkpoint", default=None, help="local .pt path (skips download)")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--skip-verify", action="store_true")
    args = ap.parse_args()

    cfg = Cfg(MODELS[args.model])
    out = args.out or f"models/maia3-{args.model}.onnx"

    ckpt_path = args.checkpoint or download_checkpoint(args.model, cache_dir=None)
    print(f"checkpoint: {ckpt_path}")

    state_dict = load_checkpoint(ckpt_path, args.device)
    model = MAIA3Model(cfg).to(args.device)
    missing, unexpected = model.load_state_dict(state_dict, strict=False)
    if missing:
        print(f"warning: missing keys: {missing[:5]}", file=sys.stderr)
    if unexpected:
        print(f"warning: unexpected keys: {unexpected[:5]}", file=sys.stderr)
    model.eval()

    if not args.skip_verify:
        print("verifying against original maia3...")
        verify_against_original(cfg, state_dict, args.device)

    export(cfg, model, out, args.device)


if __name__ == "__main__":
    main()
