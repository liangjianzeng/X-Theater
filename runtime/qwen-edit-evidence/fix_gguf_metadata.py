# -*- coding: utf-8 -*-
"""Repair metadata-less GGUF: add general.architecture / quantization_version.

unsloth's qwen-image-2.1-Q5_K_M.gguf ships with ZERO KV metadata (only
GGUF.version/tensor_count/kv_count), so ComfyUI-GGUF's detect_arch fallback
cannot classify it. Same-repo sibling (turbo) carries exactly two KVs:
general.architecture="qwen_image", general.quantization_version=2.
This script rewrites the container with those two KVs, copying every tensor
byte-for-byte via raw_dtype (no requantization).
"""
import os
import sys
import gguf

SRC = r"E:/ComfyUI/models/diffusion_models/qwen-image-2.1-Q5_K_M.gguf"
DST = SRC + ".fixed"

reader = gguf.GGUFReader(SRC)
print("src tensors:", len(reader.tensors), "src kv fields:", len(reader.fields))

writer = gguf.GGUFWriter(path=None, arch="qwen_image")
writer.add_quantization_version(2)  # mirror unsloth turbo sibling exactly

for t in reader.tensors:
    writer.add_tensor(t.name, t.data, raw_dtype=t.tensor_type)

writer.write_header_to_file(path=DST)
writer.write_kv_data_to_file()
writer.write_tensors_to_file(progress=False)
writer.close()

size = os.path.getsize(DST)
print("dst bytes:", size, "src bytes:", os.path.getsize(SRC))

# validate: re-read dst, compare tensor inventory with src, check arch KV
chk = gguf.GGUFReader(DST)
arch_f = chk.get_field("general.architecture")
arch = str(arch_f.parts[arch_f.data[-1]], encoding="utf-8")
src_inv = sorted((t.name, str(t.tensor_type), int(t.n_bytes)) for t in reader.tensors)
dst_inv = sorted((t.name, str(t.tensor_type), int(t.n_bytes)) for t in chk.tensors)
assert arch == "qwen_image", "arch KV wrong: %r" % arch
assert len(dst_inv) == 265, "tensor count %d" % len(dst_inv)
assert src_inv == dst_inv, "tensor inventory mismatch"
print("validated: arch=%s, %d tensors, inventory identical" % (arch, len(dst_inv)))
import gc
del chk, arch_f, reader, writer
gc.collect()
os.replace(DST, SRC)
print("REPLACED in place:", SRC)
