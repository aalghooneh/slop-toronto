#!/usr/bin/env python3
"""Slims a glTF car model down to what a browser can draw many times a second.

    python3 -I tools/slim-gltf.py IN.gltf|IN.glb OUT.glb --length 4.49 [--cell 0.006]
        [--cell-for 'Tire=0.02' ...] [--drop 'Shadow|License' ...] [--keep-one-wheel 'REGEX']

Source models from Sketchfab and the like run to a million triangles, most of them spent where nobody will ever
look (tyre treads modelled groove by groove, lug nuts, the inside of an exhaust). This welds every mesh's vertices
onto a grid (vertex clustering): all the vertices of one material that fall in the same cell, facing roughly the
same way, become one vertex at their average position with their average normal, and the triangles that collapse
are dropped. Creases survive because vertices facing different ways are kept apart. The cell is given in metres
(--length says how long the real car is, to find the model's scale), and can be coarser for some materials.

Textures, UVs, tangents and vertex colours are dropped: the game paints the parts itself, by material name
(js/player-car.js, js/traffic-models.js). Node names, the node tree and the materials' names and plain factors are
kept, so wheels can still be found, spun and steered. The result is one .glb with float positions, byte normals
(KHR_mesh_quantization) and the smallest index type that fits.

Needs numpy. Reads uncompressed glTF only (no Draco / meshopt input).
"""
import argparse
import base64
import json
import os
import re
import struct
import sys

import numpy as np

COMPONENTS = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTH = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def load(path):
    if path.lower().endswith('.glb'):
        with open(path, 'rb') as f:
            data = f.read()
        magic, _version, _length = struct.unpack_from('<4sII', data, 0)
        assert magic == b'glTF', 'not a .glb'
        offset = 12
        doc = None
        blob = b''
        while offset < len(data):
            size, kind = struct.unpack_from('<I4s', data, offset)
            chunk = data[offset + 8:offset + 8 + size]
            if kind == b'JSON':
                doc = json.loads(chunk)
            elif kind == b'BIN\x00':
                blob = chunk
            offset += 8 + size
        return doc, [blob]
    with open(path) as f:
        doc = json.load(f)
    blobs = []
    for b in doc.get('buffers', []):
        uri = b['uri']
        if uri.startswith('data:'):
            blobs.append(base64.b64decode(uri.split(',', 1)[1]))
        else:
            with open(os.path.join(os.path.dirname(path), uri), 'rb') as f:
                blobs.append(f.read())
    return doc, blobs


def read_accessor(doc, blobs, index):
    a = doc['accessors'][index]
    view = doc['bufferViews'][a['bufferView']]
    dtype = np.dtype(COMPONENTS[a['componentType']])
    width = WIDTH[a['type']]
    start = view.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = view.get('byteStride') or dtype.itemsize * width
    raw = np.frombuffer(blobs[view['buffer']], dtype=np.uint8, count=stride * (a['count'] - 1) + dtype.itemsize * width, offset=start)
    if stride == dtype.itemsize * width:
        out = raw.view(dtype).reshape(a['count'], width)
    else:
        rows = np.lib.stride_tricks.as_strided(raw, shape=(a['count'], dtype.itemsize * width), strides=(stride, 1))
        out = np.ascontiguousarray(rows).view(dtype).reshape(a['count'], width)
    out = out.astype(np.float32) if a['componentType'] == 5126 else out
    if a.get('normalized') and a['componentType'] != 5126:
        out = out.astype(np.float32) / np.iinfo(dtype).max
    return out


def node_matrix(node):
    if 'matrix' in node:
        return np.array(node['matrix'], dtype=np.float64).reshape(4, 4).T
    m = np.eye(4)
    if 'scale' in node:
        m = np.diag(list(node['scale']) + [1.0]) @ m
    if 'rotation' in node:
        x, y, z, w = node['rotation']
        r = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
            [0, 0, 0, 1]])
        m = r @ m
    if 'translation' in node:
        t = np.eye(4)
        t[:3, 3] = node['translation']
        m = t @ m
    return m


def world_matrices(doc):
    world = {}

    def walk(index, parent):
        m = parent @ node_matrix(doc['nodes'][index])
        world[index] = m
        for child in doc['nodes'][index].get('children', []):
            walk(child, m)

    for root in doc['scenes'][doc.get('scene', 0)]['nodes']:
        walk(root, np.eye(4))
    return world


def cluster(positions, normals, indices, cell):
    """Vertex clustering: returns (positions, normals, indices) with the vertices welded onto a grid of `cell`."""
    grid = np.floor(positions / cell).astype(np.int64)
    facing = np.rint(normals * 1.5).astype(np.int64)  # (vertices facing different ways stay apart: creases survive)
    keys = np.concatenate([grid, facing], axis=1)
    _unique, inverse = np.unique(keys, axis=0, return_inverse=True)
    inverse = inverse.reshape(-1)
    count = inverse.max() + 1
    weight = np.bincount(inverse, minlength=count).astype(np.float64)
    new_positions = np.stack([np.bincount(inverse, weights=positions[:, k], minlength=count) / weight for k in range(3)], axis=1)
    new_normals = np.stack([np.bincount(inverse, weights=normals[:, k], minlength=count) for k in range(3)], axis=1)
    length = np.linalg.norm(new_normals, axis=1, keepdims=True)
    new_normals = np.where(length > 1e-9, new_normals / np.maximum(length, 1e-9), np.array([[0.0, 1.0, 0.0]]))
    tris = inverse[indices.reshape(-1, 3)]
    alive = (tris[:, 0] != tris[:, 1]) & (tris[:, 1] != tris[:, 2]) & (tris[:, 0] != tris[:, 2])
    tris = tris[alive]
    # the same triangle twice (two layers that fell together) is drawn once
    if len(tris):
        rolled = np.stack([np.roll(tris, -k, axis=1) for k in range(3)], axis=0)
        first = np.argmin(tris, axis=1)
        canonical = rolled[first, np.arange(len(tris))]
        _u, keep = np.unique(canonical, axis=0, return_index=True)
        tris = tris[np.sort(keep)]
    # only the vertices still in use
    used = np.unique(tris)
    remap = np.full(count, -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    return new_positions[used].astype(np.float32), new_normals[used].astype(np.float32), remap[tris].astype(np.uint32)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input')
    ap.add_argument('output')
    ap.add_argument('--length', type=float, required=True, help='the real car\'s length in metres (finds the scale)')
    ap.add_argument('--cell', type=float, default=0.006, help='grid cell in metres')
    ap.add_argument('--cell-for', action='append', default=[], metavar='REGEX=METRES', help='a coarser or finer cell for the materials or nodes matching')
    ap.add_argument('--drop', action='append', default=[], metavar='REGEX', help='leave out the meshes whose node or material name matches')
    args = ap.parse_args()

    doc, blobs = load(args.input)
    used = set(doc.get('extensionsRequired', []))
    if used & {'KHR_draco_mesh_compression', 'EXT_meshopt_compression'}:
        sys.exit('compressed input is not supported')
    world = world_matrices(doc)
    drops = [re.compile(p, re.I) for p in args.drop]
    cells = [(re.compile(p.split('=')[0], re.I), float(p.split('=')[1])) for p in args.cell_for]
    material_name = lambda i: (doc['materials'][i].get('name') or '') if i is not None else ''

    # The model's length in its own units: the longest side of the box around every mesh
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    for index, node in enumerate(doc['nodes']):
        if 'mesh' not in node or index not in world:
            continue
        for prim in doc['meshes'][node['mesh']]['primitives']:
            p = read_accessor(doc, blobs, prim['attributes']['POSITION']).astype(np.float64)
            w = (np.c_[p, np.ones(len(p))] @ world[index].T)[:, :3]
            lo = np.minimum(lo, w.min(axis=0))
            hi = np.maximum(hi, w.max(axis=0))
    metres = args.length / float((hi - lo).max())

    out = bytearray()
    views = []
    accessors = []

    def add(array, target=None, normalized=False, minmax=False, stride=None):
        while len(out) % 4:
            out.append(0)
        raw = array.tobytes()
        view = {'buffer': 0, 'byteOffset': len(out), 'byteLength': len(raw)}
        if target:
            view['target'] = target
        if stride:
            view['byteStride'] = stride
        out.extend(raw)
        views.append(view)
        kinds = {v: k for k, v in COMPONENTS.items()}
        width = 1 if array.ndim == 1 else (3 if stride == 4 else array.shape[1])
        acc = {'bufferView': len(views) - 1, 'componentType': kinds[array.dtype.type], 'count': len(array),
               'type': {1: 'SCALAR', 3: 'VEC3'}[width]}
        if normalized:
            acc['normalized'] = True
        if minmax:
            acc['min'] = [float(v) for v in array.min(axis=0)]
            acc['max'] = [float(v) for v in array.max(axis=0)]
        accessors.append(acc)
        return len(accessors) - 1

    before = after = 0
    mesh_users = {}
    for index, node in enumerate(doc['nodes']):
        if 'mesh' in node:
            mesh_users.setdefault(node['mesh'], []).append(index)
    new_meshes = []
    mesh_map = {}
    for mesh_index, mesh in enumerate(doc['meshes']):
        users = mesh_users.get(mesh_index, [])
        if not users or users[0] not in world:
            continue
        node = doc['nodes'][users[0]]
        m = world[users[0]]
        scale = float(np.cbrt(abs(np.linalg.det(m[:3, :3])))) * metres  # metres per unit of this mesh's own space
        prims = []
        for prim in mesh['primitives']:
            name = f"{node.get('name', '')} {mesh.get('name', '')} {material_name(prim.get('material'))}"
            if prim.get('mode', 4) != 4 or any(d.search(name) for d in drops):
                continue
            positions = read_accessor(doc, blobs, prim['attributes']['POSITION']).astype(np.float64)
            if 'NORMAL' in prim['attributes']:
                normals = read_accessor(doc, blobs, prim['attributes']['NORMAL']).astype(np.float64)
            else:
                normals = np.tile(np.array([[0.0, 1.0, 0.0]]), (len(positions), 1))
            if 'indices' in prim:
                indices = read_accessor(doc, blobs, prim['indices']).reshape(-1).astype(np.int64)
            else:
                indices = np.arange(len(positions), dtype=np.int64)
            cell = next((c for pattern, c in cells if pattern.search(name)), args.cell)
            p, n, tris = cluster(positions, normals, indices, cell / scale)
            before += len(indices) // 3
            after += len(tris)
            if not len(tris):
                continue
            packed = np.zeros((len(n), 4), dtype=np.int8)
            packed[:, :3] = np.clip(np.rint(n * 127), -127, 127).astype(np.int8)
            flat = tris.reshape(-1)
            flat = flat.astype(np.uint16) if len(p) <= 65535 else flat.astype(np.uint32)
            new_prim = {'attributes': {'POSITION': add(p, 34962, minmax=True), 'NORMAL': add(packed, 34962, normalized=True, stride=4)},
                        'indices': add(flat, 34963)}
            if 'material' in prim:
                new_prim['material'] = prim['material']
            prims.append(new_prim)
        if prims:
            mesh_map[mesh_index] = len(new_meshes)
            new_meshes.append({'name': mesh.get('name', ''), 'primitives': prims})

    for node in doc['nodes']:
        if 'mesh' in node:
            if node['mesh'] in mesh_map:
                node['mesh'] = mesh_map[node['mesh']]
            else:
                del node['mesh']
        for key in ('skin', 'camera', 'weights'):
            node.pop(key, None)
    materials = []
    for material in doc.get('materials', []):
        pbr = material.get('pbrMetallicRoughness', {})
        slim = {'name': material.get('name', ''), 'pbrMetallicRoughness': {
            'baseColorFactor': pbr.get('baseColorFactor', [1, 1, 1, 1]),
            'metallicFactor': pbr.get('metallicFactor', 1), 'roughnessFactor': pbr.get('roughnessFactor', 1)}}
        if 'emissiveFactor' in material:
            slim['emissiveFactor'] = material['emissiveFactor']
        if material.get('alphaMode') == 'BLEND':
            slim['alphaMode'] = 'BLEND'
        if material.get('doubleSided'):
            slim['doubleSided'] = True
        materials.append(slim)
    asset = dict(doc.get('asset', {}))
    asset['generator'] = f"{asset.get('generator', '')} + slop-toronto tools/slim-gltf.py".strip(' +')
    result = {
        'asset': asset, 'scene': doc.get('scene', 0), 'scenes': doc['scenes'], 'nodes': doc['nodes'], 'meshes': new_meshes,
        'materials': materials, 'accessors': accessors, 'bufferViews': views, 'buffers': [{'byteLength': len(out)}],
        'extensionsUsed': ['KHR_mesh_quantization'], 'extensionsRequired': ['KHR_mesh_quantization'],
        'extras': {'metresPerUnit': metres}
    }
    while len(out) % 4:
        out.append(0)
    text = json.dumps(result, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    with open(args.output, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(text) + 8 + len(out)))
        f.write(struct.pack('<I4s', len(text), b'JSON'))
        f.write(text)
        f.write(struct.pack('<I4s', len(out), b'BIN\x00'))
        f.write(out)
    print(f'{before:,} triangles -> {after:,}; {os.path.getsize(args.output) / 1e6:.2f} MB; 1 unit = {metres:.5f} m')


if __name__ == '__main__':
    main()
