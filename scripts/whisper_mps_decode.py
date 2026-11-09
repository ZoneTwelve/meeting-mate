"""Bulk host transfers for Whisper beam search; scoped to one inference context.

Adapted from OpenAI Whisper v20250625 (whisper/decoding.py).
MIT License
Copyright (c) 2022 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

from contextlib import contextmanager


def beam_update(self, tokens, logits, sum_logprobs):
    import torch
    from torch.nn import functional as F

    if tokens.shape[0] % self.beam_size != 0:
        raise ValueError(f"{tokens.shape}[0] % {self.beam_size} != 0")
    n_audio = tokens.shape[0] // self.beam_size
    if self.finished_sequences is None:
        self.finished_sequences = [{} for _ in range(n_audio)]

    logprobs = F.log_softmax(logits.float(), dim=-1)
    values, indices = logprobs.topk(self.beam_size + 1, dim=-1)
    # Retain float32 GPU addition, candidate ordering and duplicate overwrites.
    # Three bulk reads replace per-candidate .item() calls and per-beam .tolist().
    candidate_scores = (sum_logprobs[:, None] + values).tolist()
    candidate_tokens = indices.tolist()
    prefixes = tokens.tolist()
    next_tokens, next_scores, source_indices, finished_sequences = [], [], [], []
    for i in range(n_audio):
        scores, sources, finished = {}, {}, {}
        for j in range(self.beam_size):
            idx = i * self.beam_size + j
            for score, token in zip(candidate_scores[idx], candidate_tokens[idx]):
                sequence = tuple(prefixes[idx] + [token])
                scores[sequence] = score
                sources[sequence] = idx
        saved = 0
        for sequence in sorted(scores, key=scores.get, reverse=True):
            if sequence[-1] == self.eot:
                finished[sequence] = scores[sequence]
            else:
                next_scores.append(scores[sequence])
                next_tokens.append(sequence)
                source_indices.append(sources[sequence])
                saved += 1
                if saved == self.beam_size:
                    break
        finished_sequences.append(finished)

    sum_logprobs.copy_(torch.tensor(next_scores, dtype=sum_logprobs.dtype, device=sum_logprobs.device))
    tokens = torch.tensor(next_tokens, device=tokens.device)
    self.inference.rearrange_kv_cache(source_indices)
    assert len(self.finished_sequences) == len(finished_sequences)
    for previous, newly_finished in zip(self.finished_sequences, finished_sequences):
        for seq in sorted(newly_finished, key=newly_finished.get, reverse=True):
            if len(previous) >= self.max_candidates:
                break
            previous[seq] = newly_finished[seq]
    completed = all(len(sequences) >= self.max_candidates for sequences in self.finished_sequences)
    return tokens, completed


def rearrange_kv_cache(self, source_indices):
    import torch

    if source_indices == list(range(len(source_indices))):
        return
    # Reuse one device index tensor across every layer's key/value tensors.
    device = self.kv_cache[self.kv_modules[0]].device
    indices = torch.tensor(source_indices, device=device, dtype=torch.long)
    for module in self.kv_modules:
        self.kv_cache[module] = self.kv_cache[module].index_select(0, indices).detach()


@contextmanager
def optimized_decoding():
    """Single-threaded Whisper worker only; never patch installed site-packages."""
    import whisper
    from whisper import decoding

    if whisper.__version__ != "20250625":
        raise RuntimeError("MPS decoding optimization requires openai-whisper==20250625")
    originals = decoding.BeamSearchDecoder.update, decoding.PyTorchInference.rearrange_kv_cache
    decoding.BeamSearchDecoder.update = beam_update
    decoding.PyTorchInference.rearrange_kv_cache = rearrange_kv_cache
    try:
        yield
    finally:
        decoding.BeamSearchDecoder.update, decoding.PyTorchInference.rearrange_kv_cache = originals
