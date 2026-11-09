"""Compare optimized beam decisions and KV caches against pinned upstream code.

Run with transcript-mps-venv; no models, downloads, or recordings are needed.
"""
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
# Set the worker's device/thread policy before importing Torch.
import transcribe
import whisper_mps_decode as optimized

try:
    import torch
    import whisper
    from whisper import decoding
except ImportError:
    torch = None


@unittest.skipIf(torch is None, "Requires the optional MPS environment")
class DecoderTest(unittest.TestCase):
    def devices(self):
        return ["cpu", "mps"] if torch.backends.mps.is_available() else ["cpu"]

    def test_beam_decisions_scores_finished_sequences_and_patience(self):
        for device in self.devices():
            for beams, audios, patience, tied in [(1, 1, 1, False), (2, 2, 1.5, False),
                                                 (5, 1, 1, False), (5, 2, 1.6, True)]:
                with self.subTest(device=device, beams=beams, audios=audios, patience=patience, tied=tied):
                    generator = torch.Generator().manual_seed(716)
                    source_a, source_b = [], []
                    old = decoding.BeamSearchDecoder(beams, 1, SimpleNamespace(rearrange_kv_cache=source_a.append), patience)
                    new = decoding.BeamSearchDecoder(beams, 1, SimpleNamespace(rearrange_kv_cache=source_b.append), patience)
                    # Identical prefixes exercise duplicate candidate overwrites.
                    tokens_a = torch.tensor([[2, 3]] * (beams * audios), device=device)
                    tokens_b = tokens_a.clone()
                    scores_a = torch.zeros(beams * audios, device=device)
                    scores_b = scores_a.clone()
                    for step in range(5):
                        logits = torch.randn((beams * audios, 32), generator=generator)
                        if tied:
                            logits = logits.round()
                        logits[:, 1] += step - 2  # Eventually finish, including patience > 1.
                        logits[:, 31] = -float("inf")
                        logits = logits.to(device=device, dtype=torch.float16)
                        tokens_a, done_a = old.update(tokens_a, logits.clone(), scores_a)
                        tokens_b, done_b = optimized.beam_update(new, tokens_b, logits.clone(), scores_b)
                        self.assertTrue(torch.equal(tokens_a, tokens_b))
                        self.assertTrue(torch.equal(scores_a, scores_b))
                        self.assertEqual(old.finished_sequences, new.finished_sequences)
                        self.assertEqual(source_a, source_b)
                        self.assertEqual(done_a, done_b)
                    final_a, ranks_a = old.finalize(tokens_a.reshape(audios, beams, -1), scores_a.reshape(audios, beams))
                    final_b, ranks_b = new.finalize(tokens_b.reshape(audios, beams, -1), scores_b.reshape(audios, beams))
                    self.assertEqual(ranks_a, ranks_b)
                    self.assertEqual([[t.tolist() for t in group] for group in final_a],
                                     [[t.tolist() for t in group] for group in final_b])
                    old.reset()
                    new.reset()
                    self.assertIsNone(new.finished_sequences)

    def test_rejects_invalid_beam_shape(self):
        beam = decoding.BeamSearchDecoder(5, 1, None)
        with self.assertRaises(ValueError):
            optimized.beam_update(beam, torch.zeros(3, 2), torch.zeros(3, 32), torch.zeros(3))

    def test_cache_reorder_with_duplicates_noncontiguous_and_identity(self):
        for device in self.devices():
            for order in [[0, 1, 2, 3, 4], [4, 4, 0, 2, 1]]:
                with self.subTest(device=device, order=order):
                    caches = {key: torch.arange(5 * 3 * 4, device=device).reshape(5, 3, 4).transpose(1, 2)
                              for key in range(4)}
                    old = SimpleNamespace(kv_modules=list(caches), kv_cache=dict(caches))
                    new = SimpleNamespace(kv_modules=list(caches), kv_cache=dict(caches))
                    decoding.PyTorchInference.rearrange_kv_cache(old, order)
                    optimized.rearrange_kv_cache(new, order)
                    for key in caches:
                        self.assertTrue(torch.equal(old.kv_cache[key], new.kv_cache[key]))
                        if order == list(range(5)):
                            self.assertIs(new.kv_cache[key], caches[key])

    def test_nested_context_restores_methods_even_on_error(self):
        original = decoding.BeamSearchDecoder.update, decoding.PyTorchInference.rearrange_kv_cache
        with self.assertRaisesRegex(RuntimeError, "test failure"):
            with optimized.optimized_decoding():
                with optimized.optimized_decoding():
                    self.assertIs(decoding.BeamSearchDecoder.update, optimized.beam_update)
                self.assertIs(decoding.BeamSearchDecoder.update, optimized.beam_update)
                raise RuntimeError("test failure")
        self.assertEqual(original, (decoding.BeamSearchDecoder.update, decoding.PyTorchInference.rearrange_kv_cache))

    def test_rejects_unverified_whisper_version_before_patching(self):
        original = decoding.BeamSearchDecoder.update
        with patch.object(whisper, "__version__", "unknown"), self.assertRaisesRegex(RuntimeError, "20250625"):
            with optimized.optimized_decoding():
                self.fail("Unexpected context entry")
        self.assertIs(decoding.BeamSearchDecoder.update, original)


if __name__ == "__main__":
    unittest.main()
