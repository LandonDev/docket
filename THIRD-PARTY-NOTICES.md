# Third-party notices

TempCode is Landon Hale's own code and carries no licence of its own. This file lists what it ships from others, with each licence and copyright line, and the tools it runs beside it. `bun scripts/third-party-notices.ts` writes it from `node_modules` and the tool manifests; `scripts/thirdPartyNotices.test.ts` checks that it names every shipped package and that each licence is allowed.

## Changed files we carry

work-kit (bundled into the app) changes Univer 1.5.2's formula engine (`@univerjs/engine-formula`, Apache-2.0, Copyright 2023-present DreamNum Co., Ltd.) by replacing two of its services in `work-kit/src/sheet/engine/`: `dependency-generator.ts` subclasses `FormulaDependencyGenerator` and plans a calculation from the cells an edit can reach in place of the whole workbook, reading three of its private members; `dependency-manager.ts` and `dedup-rtree.ts` replace `DependencyManagerService`'s index with one that removes exactly what it inserted. `plugin.ts` registers both in place of Univer's own. These files are our changes to Univer; Univer's own files ship unmodified. Univer's licence is Apache-2.0, given below.

pdf.js's character maps, two standard fonts and two image decoders ship as lazy assets, each beside its own licence notice (`src/renderer/src/work/pdf/pdfjsData.ts`). The JetBrains Mono font ships under the SIL Open Font License 1.1 (`src/renderer/src/assets/fonts/JetBrainsMono-OFL.txt`). Electron carries its own notices for Chromium and Node.js inside the app (`LICENSES.chromium.html`).

Live video speaks screen-relay's wire (github.com/vercel-labs/screen-relay, version 0.1.2, Apache-2.0, given below). `src/shared/video/nsl1.ts` is ported from its `src/protocol/index.ts` and PROTOCOL.md and says in its head what was changed: only the frame, the ack and the input message are kept, and a frame encoder is added. `native/tc-computer/Sources/ComputerServiceKit/FlowControl.swift` is ported from its `src/engine/core/flow.hpp`, and its tests from its flow test (`flow-test.cpp`); its head says what was changed: C++ to Swift, Swift's names, the wrapping sums written as such, the rules and numbers as they were. screen-relay's engine itself is not in the app: it is a tool, below.

## Tools run as separate processes

The host installs these on demand under `<userData>/work-tools/` (scripts/work-tools/*.json) and runs each as its own process; none is linked into TempCode, bundled with it or changed. ONLYOFFICE (AGPL-3.0), PyMuPDF (AGPL-3.0), ffmpeg (GPL-3.0) and x264 (GPL-2.0-or-later, behind screen-relay's engine on the box) are among them: each runs unmodified as a separate program, and ONLYOFFICE's editor is never offered to a guest.

| Tool | Version | Licence | Pillar | How it is used |
|---|---|---|---|---|
| libreoffice | 26.8.3 | MPL-2.0 | toolchain | The Document Foundation's official build, unpacked and unmodified; runs only as a separate soffice process. Carlito and Caladea (OFL-1.1) ship inside it. |
| python | 3.12.16 | PSF-2.0 | toolchain | Astral's python-build-standalone build of CPython (20261110), unpacked and unmodified; the libraries inside it keep their own permissive licences. |
| venv | 3.12.16 | PSF-2.0 | toolchain | A virtual environment of the python tool, with the pip it bundles (MIT). Pillars add packages to it with a pip tool of their own; an AGPL package (PyMuPDF) runs only as a separate, unmodified Python process. |
| ffmpeg | 9.0.2 | GPL-3.0-or-later | toolchain | Static release builds (Martin Riedl's for Linux and macOS, Gyan Doshi's essentials for Windows), built with GPL parts; run only as separate, unmodified ffmpeg and ffprobe processes, never linked into our code. |
| ironcalc | 0.9.1 | MIT OR Apache-2.0 | toolchain | The IronCalc engine's native Node binding (@ironcalc/nodejs and its platform package), unmodified; permissive, so the host may load it in process. |
| screen-relay | 0.1.2 | Apache-2.0 AND GPL-2.0-or-later AND MIT | browser | Vercel Labs' screen-relay 0.1.2 (Apache-2.0): its engine, relay-engine, built on this host from the published npm package, unmodified, against Ubuntu 24.04's own packages unpacked beside it with no root: x264 (GPL-2.0-or-later), libwebsockets (MIT), zlib (Zlib), OpenSSL (Apache-2.0), libcap (BSD-3-Clause OR GPL-2.0-only), libev (BSD-2-Clause OR GPL-2.0-or-later), libuv (MIT) and the X client libraries (MIT), found by pkgconf (ISC). With it the X.Org server and its dummy video driver (MIT) for the box browser's private display, and xclip (GPL-2.0-or-later) for his paste. Each runs only as a separate, unmodified process the browser pillar starts on the box; none is linked into our code, bundled, or shipped in the app. The wire the engine speaks is ported into the app under screen-relay's Apache-2.0 notice (src/shared/video/nsl1.ts). |
| pymupdf4llm | 2.1 | AGPL-3.0-only | formats | pymupdf4llm 2.1 and PyMuPDF 2.1 (GNU AGPL 3.0 or Artifex's commercial licence; pymupdf_layout 2.1 is an empty package PyMuPDF 2 requires), with the closure pip-lock.ts pinned: onnxruntime MIT, numpy BSD-3-Clause, networkx BSD-3-Clause, flatbuffers Apache-2.0, protobuf BSD-3-Clause, PyYAML MIT, packaging Apache-2.0 OR BSD-2-Clause, psutil BSD-3-Clause, tabulate MIT. AGPL: it runs only as a separate, unmodified Python process on a host (a PDF to markdown, milestone 21); nothing of it is linked into the app or shipped in its bundle. |
| docling-venv | 3.12.16 | PSF-2.0 | formats | A virtual environment of the python tool, Docling's own: its closure (torch, numpy, transformers) would fight the shared venv's pins. |
| docling | 2.151.0 | MIT | formats | Docling 2.151.0 (MIT, docling-ibm-models and docling-parse MIT) with PyTorch 2.14.1 and torchvision 0.29.1, the CPU builds from download.pytorch.org (BSD-3-Clause), and the rest of its closure pinned by hash: 102 wheels, every licence permissive (Apache-2.0, MIT, BSD, PSF, MPL-2.0 for certifi), none GPL or with use limits (scanned 2026-11-19). Run as a separate Python process on the box: the PDF import's fallback for tables, columns and scans (milestone 21). About 1.8 GB. |
| docling-models | heron-8f39ad3.tableformer-fc0f2d4.rapidocr-3.10.0 | Apache-2.0 AND CDLA-Permissive-2.0 | formats | The models Docling reads with --artifacts-path, kept as downloaded: the layout model docling-layout-heron (Apache-2.0, commit 8f39ad3), TableFormer accurate from docling-models (CDLA-Permissive-2.0, commit fc0f2d4), and RapidOCR's PP-OCRv6 small torch weights and dictionary (Apache-2.0, RapidOCR v3.10.0, the hashes rapidocr itself lists). Read only by the docling tool's process and by Money's receipt reader, a short script run as a separate Python process of the same venv (the RapidOCR weights alone). About 400 MB. |
| meetings-venv | 3.12.16 | PSF-2.0 | meetings | The meetings pillar's own virtual environment of the python tool, with the pip it bundles (MIT), so its numpy pin never meets another pillar's packages in the shared venv. |
| sherpa-onnx | 2.0.1 | Apache-2.0 | meetings | sherpa-onnx and sherpa-onnx-core (Apache-2.0, with the onnxruntime it carries inside, MIT) and numpy (BSD-3-Clause, with 0BSD, MIT, Zlib and CC0-1.0 parts), wheels only, into the meetings venv. Runs only in a separate Python process with the network blocked. |
| parakeet-tdt-v2 | 0.6b-v2-int8 | CC-BY-4.0 | meetings | NVIDIA's Parakeet TDT 0.6B v2 weights (CC-BY-4.0: credit NVIDIA), as sherpa-onnx's int8 ONNX export, kept as downloaded. Loaded only by sherpa-onnx in the transcriber's own process. |
| pyannote-segmentation | 3.0 | MIT | meetings | pyannote segmentation-3.0 (MIT, CNRS), as sherpa-onnx's ONNX export with its licence file, kept as downloaded; needs no Hugging Face token. Loaded only by sherpa-onnx in the transcriber's own process. |
| wespeaker-resnet34-lm | voxceleb-resnet34-lm | CC-BY-4.0 | meetings | WeSpeaker's ResNet34-LM speaker embedding trained on VoxCeleb; WeSpeaker's pretrained models carry their training data's licence, VoxCeleb's CC-BY-4.0 (credit WeSpeaker and VoxCeleb). sherpa-onnx's ONNX export, kept as downloaded. Loaded only by sherpa-onnx in the transcriber's own process. |
| silero-vad | 4-16k | MIT | meetings | Silero VAD v4 (MIT, Silero Team), as k2-fsa exported it to ONNX with only the 16 kHz branch, kept as downloaded. Loaded only by sherpa-onnx in the transcriber's own process. |
| onlyoffice | 10.0.0 | AGPL-3.0-only | sheets | ONLYOFFICE Docs Community 10.0.0 (Ascensio System SIA), AGPLv3 with the additional terms in its LICENSE.txt: notices kept, no trademark use. The vendor's .deb unpacked unmodified with no root; the probe runs the vendor's own postinst steps (fonts, themes, the JS cache, api.js from its template). It runs only on the box, as a separate docservice process the full editor starts, reached through the Work service's /w/full route; never linked, bundled, shipped in the app, or served to a guest (architecture §12.1). |
| pdf-tools | 0.11.10 | MIT | pdf | pdfplumber 0.11.10 (MIT) for text, words and tables, and pypdfium2 5.15.2 (Apache-2.0 OR BSD-3-Clause; the PDFium inside it BSD-3-Clause and Apache-2.0) for page pictures, with the closure pip-lock.ts pinned: pdfminer.six MIT, Pillow MIT-CMU, cryptography Apache-2.0 OR BSD-3-Clause, cffi MIT-0, pycparser BSD-3-Clause, charset-normalizer MIT. Wheels only, into the shared venv; the host runs them as a separate Python process. Nothing GPL or AGPL: PyMuPDF is not used. |
| pdf-font | 2.015 | OFL-1.1 | pdf | Noto Sans Regular 2.015, one TrueType file as published by the Noto project at a fixed commit, unmodified. The host embeds a subset of it in a PDF it fills (pdf-lib), which the SIL Open Font License allows. |
| python-pptx | 1.0.2 | MIT | slides | python-pptx (MIT) and the closure pip-lock.ts pinned: lxml (BSD-3-Clause), Pillow (MIT-CMU), XlsxWriter (BSD-2-Clause), typing_extensions (PSF-2.0); wheels only, into the shared venv. The slides pillar runs it as a separate Python process to read and edit .pptx files. |
| qemu-window | 8.2.2+ds-0ubuntu1.18 | GPL-2.0-only AND LGPL-3.0-or-later AND GPL-3.0-or-later | winvm | Ubuntu 24.04's own QEMU window modules (ui-gtk and ui-opengl from qemu-system-gui and qemu-system-modules-opengl, GPL-2.0-only) and the VTE library they load (libvte-2.91, LGPL-3.0-or-later with GPL-3.0-or-later parts), unpacked on this host with no root and nothing registered. QEMU loads them into its own process, the box's own qemu-system-x86_64 of the same build, which the Windows VM's keeper runs as a separate, unmodified process; none is linked into our code, bundled, or shipped in the app. They must match the box's QEMU build exactly: the version is the one Ubuntu ships in noble-updates. |

The speech models credit their makers as CC BY 4.0 asks: Parakeet TDT 0.6B v2 by NVIDIA (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/), converted to ONNX int8 by the sherpa-onnx project; the WeSpeaker ResNet34-LM speaker model by the WeSpeaker project, trained on VoxCeleb (CC BY 4.0), as exported by sherpa-onnx. Neither is changed.

## Packages shipped in the app

726 packages. A package's builds for each platform (its optional dependencies) ship under its own licence and are not listed apart.

| Package | Version | Licence | Copyright |
|---|---|---|---|
| @antfu/install-pkg | 2.0.1 | MIT | Copyright (c) 2021 Anthony Fu <https://github.com/antfu> |
| @anthropic-ai/claude-agent-sdk | 0.3.280 | SEE LICENSE IN README.md | © Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance. |
| @babel/runtime | 7.29.7 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors |
| @base-ui/react | 1.9.0 | MIT | Copyright (c) 2019 Material-UI SAS |
| @base-ui/utils | 0.5.0 | MIT | Copyright (c) 2019 Material-UI SAS |
| @blocknote/core | 0.57.0 | MPL-2.0 | (c) under Patent Claims infringed by Covered Software in the absence of |
| @blocknote/react | 0.57.0 | MPL-2.0 | (c) under Patent Claims infringed by Covered Software in the absence of |
| @blocknote/shadcn | 0.57.0 | MPL-2.0 | (c) under Patent Claims infringed by Covered Software in the absence of |
| @braintree/sanitize-url | 7.1.2 | MIT | Copyright (c) 2017 Braintree |
| @chevrotain/types | 11.1.2 | Apache-2.0 |  |
| @codemirror/autocomplete | 6.20.3 | MIT | Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @codemirror/commands | 6.11.0 | MIT | Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @codemirror/lang-css | 6.3.1 | MIT | Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @codemirror/lang-html | 6.4.12 | MIT | Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @codemirror/lang-javascript | 6.2.5 | MIT | Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @codemirror/lang-json | 6.0.2 | MIT | Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @codemirror/lang-markdown | 6.5.2 | MIT | Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @codemirror/lang-python | 6.2.1 | MIT | Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @codemirror/lang-rust | 6.0.2 | MIT | Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @codemirror/language | 6.12.4 | MIT | Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @codemirror/lint | 6.9.7 | MIT | Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @codemirror/merge | 6.12.2 | MIT | Copyright (C) 2018-2022 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @codemirror/search | 6.7.2 | MIT | Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @codemirror/state | 6.7.4 | MIT | Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @codemirror/view | 6.43.11 | MIT | Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @date-fns/tz | 1.5.0 | MIT | Copyright © 2024 Sasha Koss |
| @electron-toolkit/preload | 3.0.2 | MIT | Copyright (c) 2022-present, Alex.Wei |
| @electron-toolkit/utils | 4.0.0 | MIT | Copyright (c) 2022-present, Alex.Wei |
| @flatten-js/interval-tree | 1.1.3 | MIT | Copyright (c) 2017 alexbol99 |
| @floating-ui/core | 1.8.0 | MIT | Copyright (c) 2021-present Floating UI contributors |
| @floating-ui/dom | 1.8.0 | MIT | Copyright (c) 2021-present Floating UI contributors |
| @floating-ui/react | 0.27.20 | MIT | Copyright (c) 2021-present Floating UI contributors |
| @floating-ui/react-dom | 2.1.9 | MIT | Copyright (c) 2021-present Floating UI contributors |
| @floating-ui/utils | 0.2.12 | MIT | Copyright (c) 2021-present Floating UI contributors |
| @grpc/grpc-js | 1.14.7 | Apache-2.0 |  |
| @grpc/proto-loader | 0.8.1 | Apache-2.0 |  |
| @handlewithcare/prosemirror-inputrules | 0.1.4 | MIT | Copyright (c) 2025 Handle with Care Collective |
| @hocuspocus/common | 4.8.0 | MIT | Copyright (c) 2023, Tiptap GmbH |
| @hocuspocus/provider | 4.4.0 | MIT | Copyright (c) 2023, Tiptap GmbH |
| @hocuspocus/server | 4.4.0 | MIT | Copyright (c) 2023, Tiptap GmbH |
| @hono/node-server | 2.1.0 | MIT | Copyright (c) 2022 - present, Yusuke Wada and Hono contributors |
| @hugeicons/core-free-icons | 4.3.0 | MIT |  |
| @hugeicons/react | 1.1.10 | MIT | Copyright (c) 2025 Hugeicons |
| @iconify/types | 2.0.0 | MIT | Copyright (c) 2021 - 2022 Vjacheslav Trushkin / Iconify OÜ |
| @iconify/utils | 3.1.7 | MIT | Copyright (c) 2021-PRESENT Vjacheslav Trushkin |
| @jridgewell/gen-mapping | 0.3.13 | MIT | Copyright 2024 Justin Ridgewell <justin@ridgewell.name> |
| @jridgewell/remapping | 2.3.5 | MIT | Copyright 2024 Justin Ridgewell <justin@ridgewell.name> |
| @jridgewell/resolve-uri | 3.1.2 | MIT | Copyright 2019 Justin Ridgewell <jridgewell@google.com> |
| @jridgewell/sourcemap-codec | 1.5.5 | MIT | Copyright 2024 Justin Ridgewell <justin@ridgewell.name> |
| @jridgewell/trace-mapping | 0.3.31 | MIT | Copyright 2024 Justin Ridgewell <justin@ridgewell.name> |
| @js-sdsl/ordered-map | 4.4.2 | MIT | Copyright (c) 2021 Zilong Yao |
| @lezer/common | 1.5.2 | MIT | Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @lezer/css | 1.3.6 | MIT | Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @lezer/highlight | 1.2.3 | MIT | Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @lezer/html | 1.3.13 | MIT | Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @lezer/javascript | 1.5.4 | MIT | Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @lezer/json | 1.0.3 | MIT | Copyright (C) 2020 by Marijn Haverbeke <marijn@haverbeke.berlin>, Arun Srinivasan <rulfzid@gmail.com>, and others |
| @lezer/lr | 1.4.10 | MIT | Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @lezer/markdown | 1.7.2 | MIT | Copyright (C) 2020 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @lezer/python | 1.1.19 | MIT | Copyright (C) 2020 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @lezer/rust | 1.0.2 | MIT | Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| @lifeomic/attempt | 3.1.0 | MIT | Copyright 2018 LifeOmic |
| @marijn/find-cluster-break | 1.0.4 | MIT | Copyright (C) 2024 by Marijn Haverbeke <marijn@haverbeke.berlin> |
| @mermaid-js/parser | 1.2.1 | MIT | Copyright (c) 2023 Yokozuna59 |
| @modelcontextprotocol/sdk | 1.30.0 | MIT | Copyright (c) 2024 Anthropic, PBC |
| @muse-code/sdk | 1.4.14 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| @noble/hashes | 1.8.0 | MIT | Copyright (c) 2022 Paul Miller (https://paulmillr.com) |
| @pdf-lib/fontkit | 1.1.1 | MIT |  |
| @pdf-lib/standard-fonts | 1.0.0 | MIT | Copyright (c) 2018 Andrew Dillon |
| @pdf-lib/upng | 1.0.1 | MIT | Copyright (c) 2017 Photopea |
| @protobufjs/aspromise | 1.1.2 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. |
| @protobufjs/base64 | 1.1.2 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. |
| @protobufjs/codegen | 2.0.5 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. |
| @protobufjs/eventemitter | 1.1.1 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. |
| @protobufjs/fetch | 1.1.1 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. |
| @protobufjs/float | 1.0.2 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. |
| @protobufjs/path | 1.1.2 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. |
| @protobufjs/pool | 1.1.0 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. |
| @protobufjs/utf8 | 1.1.2 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. |
| @radix-ui/primitive | 1.2.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-arrow | 1.1.17 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-collection | 1.2.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-compose-refs | 1.1.5 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-context | 1.3.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-dialog | 1.3.1 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-direction | 1.2.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-dismissable-layer | 1.2.1 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-dropdown-menu | 2.2.1 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-focus-guards | 1.2.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-focus-scope | 1.3.1 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-hover-card | 1.2.1 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-id | 1.1.4 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-menu | 2.2.1 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-popover | 1.3.1 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-popper | 1.4.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-portal | 1.2.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-presence | 1.1.11 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-primitive | 2.2.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-roving-focus | 1.2.1 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-separator | 1.2.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-slot | 1.5.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-use-callback-ref | 1.1.5 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-use-controllable-state | 1.3.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-use-effect-event | 0.0.5 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-use-is-hydrated | 0.1.3 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-use-layout-effect | 1.1.4 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-use-rect | 1.1.4 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-use-size | 1.1.5 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/rect | 1.1.3 | MIT | Copyright (c) 2022 WorkOS |
| @reduxjs/toolkit | 2.13.0 | MIT | Copyright (c) 2018 Mark Erikson |
| @shikijs/core | 3.23.0 | MIT | Copyright (c) 2021 Pine Wu; Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |
| @shikijs/engine-javascript | 3.23.0 | MIT | Copyright (c) 2021 Pine Wu; Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |
| @shikijs/engine-oniguruma | 3.23.0 | MIT | Copyright (c) 2021 Pine Wu; Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |
| @shikijs/langs | 3.23.0 | MIT | Copyright (c) 2021 Pine Wu; Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |
| @shikijs/monaco | 3.23.0 | MIT | Copyright (c) 2021 Pine Wu; Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |
| @shikijs/themes | 3.23.0 | MIT | Copyright (c) 2021 Pine Wu; Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |
| @shikijs/types | 3.23.0 | MIT | Copyright (c) 2021 Pine Wu; Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |
| @shikijs/types | 4.6.0 | MIT | Copyright (c) 2021 Pine Wu; Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |
| @shikijs/vscode-textmate | 10.0.2 | MIT | Copyright (c) Microsoft Corporation |
| @shikijs/vscode-textmate | 10.1.0 | MIT | Copyright (c) Microsoft Corporation |
| @standard-schema/spec | 1.1.0 | MIT | Copyright (c) 2024 Colin McDonnell |
| @standard-schema/utils | 0.3.0 | MIT | Copyright (c) 2024 Fabian Hiller |
| @streamdown/code | 1.1.1 | Apache-2.0 | Copyright 2023 Vercel, Inc. |
| @streamdown/mermaid | 1.0.2 | Apache-2.0 | Copyright 2023 Vercel, Inc. |
| @tabler/icons | 3.52.0 | MIT | Copyright (c) 2020-2026 Paweł Kuna |
| @tabler/icons-react | 3.52.0 | MIT | Copyright (c) 2020-2026 Paweł Kuna |
| @tailwindcss/node | 4.3.3 | MIT | Copyright (c) Tailwind Labs, Inc. |
| @tailwindcss/oxide | 4.3.3 | MIT | Copyright (c) Tailwind Labs, Inc. |
| @tailwindcss/vite | 4.3.3 | MIT | Copyright (c) Tailwind Labs, Inc. |
| @tanstack/react-virtual | 3.14.12 | MIT | Copyright (c) 2021-present Tanner Linsley |
| @tanstack/virtual-core | 3.17.10 | MIT | Copyright (c) 2021-present Tanner Linsley |
| @tiptap/core | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-blockquote | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-bold | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-bubble-menu | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-bullet-list | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-code | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-code-block | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-document | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-dropcursor | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-gapcursor | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-hard-break | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-heading | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-horizontal-rule | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-image | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-italic | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-link | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-list | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-list-item | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-list-keymap | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-ordered-list | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-paragraph | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-strike | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-table | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-text | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extension-underline | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/extensions | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/pm | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/react | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @tiptap/starter-kit | 3.34.0 | MIT | Copyright (c) 2025, Tiptap GmbH |
| @types/d3 | 7.4.3 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-array | 3.2.2 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-axis | 3.0.6 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-brush | 3.0.6 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-chord | 3.0.6 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-color | 3.1.3 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-contour | 3.0.6 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-delaunay | 6.0.4 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-dispatch | 3.0.7 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-drag | 3.0.7 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-dsv | 3.0.7 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-ease | 3.0.2 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-fetch | 3.0.7 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-force | 3.0.10 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-format | 3.0.4 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-geo | 3.1.1 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-hierarchy | 3.1.7 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-interpolate | 3.0.4 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-path | 3.1.1 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-polygon | 3.0.2 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-quadtree | 3.0.6 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-random | 3.0.4 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-scale | 4.0.9 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-scale-chromatic | 3.1.0 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-selection | 3.0.11 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-shape | 3.2.0 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-time | 3.0.4 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-time-format | 4.0.3 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-timer | 3.0.2 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-transition | 3.0.9 | MIT | Copyright (c) Microsoft Corporation. |
| @types/d3-zoom | 3.0.8 | MIT | Copyright (c) Microsoft Corporation. |
| @types/debug | 4.1.13 | MIT | Copyright (c) Microsoft Corporation. |
| @types/estree | 1.0.9 | MIT | Copyright (c) Microsoft Corporation. |
| @types/estree-jsx | 1.0.5 | MIT | Copyright (c) Microsoft Corporation. |
| @types/geojson | 7946.0.16 | MIT | Copyright (c) Microsoft Corporation. |
| @types/hast | 3.0.5 | MIT | Copyright (c) Microsoft Corporation. |
| @types/mdast | 4.0.4 | MIT | Copyright (c) Microsoft Corporation. |
| @types/ms | 2.1.0 | MIT | Copyright (c) Microsoft Corporation. |
| @types/node | 22.20.1 | MIT | Copyright (c) Microsoft Corporation. |
| @types/node | 26.6.6 | MIT | Copyright (c) Microsoft Corporation. |
| @types/unist | 2.0.11 | MIT | Copyright (c) Microsoft Corporation. |
| @types/unist | 3.0.3 | MIT | Copyright (c) Microsoft Corporation. |
| @types/use-sync-external-store | 0.0.6 | MIT | Copyright (c) Microsoft Corporation. |
| @ungap/structured-clone | 1.3.3 | ISC | Copyright (c) 2021, Andrea Giammarchi, @WebReflection |
| @univerjs/core | 1.5.2 | Apache-2.0 |  |
| @univerjs/data-validation | 1.5.2 | Apache-2.0 |  |
| @univerjs/design | 1.5.2 | Apache-2.0 |  |
| @univerjs/docs | 1.5.2 | Apache-2.0 |  |
| @univerjs/docs-ui | 1.5.2 | Apache-2.0 |  |
| @univerjs/drawing | 1.5.2 | Apache-2.0 |  |
| @univerjs/engine-formula | 1.5.2 | Apache-2.0 |  |
| @univerjs/engine-render | 1.5.2 | Apache-2.0 |  |
| @univerjs/find-replace | 1.5.2 | Apache-2.0 |  |
| @univerjs/icons | 1.47.0 | MIT | Copyright (c) 2023-present, DreamNum Co., Ltd. |
| @univerjs/protocol | 1.5.2 | Apache-2.0 |  |
| @univerjs/rpc | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-conditional-formatting | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-conditional-formatting-ui | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-data-validation | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-data-validation-ui | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-filter | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-filter-ui | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-find-replace | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-formula | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-formula-ui | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-hyper-link | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-hyper-link-ui | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-note | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-note-ui | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-numfmt | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-numfmt-ui | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-sort | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-sort-ui | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-table | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-table-ui | 1.5.2 | Apache-2.0 |  |
| @univerjs/sheets-ui | 1.5.2 | Apache-2.0 |  |
| @univerjs/telemetry | 1.5.2 | Apache-2.0 |  |
| @univerjs/themes | 1.5.2 | Apache-2.0 |  |
| @univerjs/ui | 1.5.2 | Apache-2.0 |  |
| @upsetjs/venn.js | 2.0.0 | MIT | Copyright (c) 2013 Ben Frederickson; Copyright (c) 2021 Samuel Gratzl |
| @vscode/l10n | 0.0.18 | MIT |  |
| @vtsls/language-server | 0.3.0 | MIT | Copyright (c) 2023 yioneko; Copyright (c) 2015 - present Microsoft Corporation |
| @vtsls/language-service | 0.3.0 | MIT | Copyright (c) 2023 yioneko; Copyright (c) 2015 - present Microsoft Corporation |
| @vtsls/vscode-fuzzy | 0.1.0 | MIT | Copyright (c) 2023 yioneko; Copyright (c) 2015 - present Microsoft Corporation |
| @wendellhu/redi | 1.1.3 | MIT | Copyright 2021 Wendell Hu |
| @xmldom/xmldom | 0.9.12 | MIT | Copyright 2019 - present Christopher J. Brody and other contributors, as listed in: https://github.com/xmldom/xmldom/graphs/contributors; Copyright 2012 - 2017 @jindw <jindw@xidea.org> and other contributors, as listed in: https://github.com/jindw/xmldom/graphs/contributors |
| @xterm/xterm | 6.0.0 | MIT | Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js); Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com); Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/) |
| accepts | 2.0.0 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com> |
| ajv | 8.20.0 | MIT | Copyright (c) 2015-2021 Evgeny Poberezkin |
| ajv-formats | 3.0.1 | MIT | Copyright (c) 2020 Evgeny Poberezkin |
| aliax-core | 0.1.0 | MIT | Copyright (c) 2026 Landon Hale |
| ansi-regex | 5.0.1 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| ansi-styles | 4.3.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| argparse | 2.0.1 | Python-2.0 | Copyright (c) 1991 - 1995, Stichting Mathematisch Centrum Amsterdam, |
| aria-hidden | 1.2.6 | MIT | Copyright (c) 2017 Anton Korzunov |
| async-lock | 1.5.0 | MIT | Copyright (c) 2016 Rogier Schouten <github@workingcode.ninja> |
| async-mutex | 0.5.0 | MIT | Copyright (c) 2016 Christian Speckner <cnspeckn@googlemail.com> |
| bail | 2.0.2 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| body-parser | 2.3.0 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2014-2015 Douglas Christopher Wilson <doug@somethingdoug.com> |
| builder-util-runtime | 9.7.0 | MIT | Copyright (c) 2015 Loopline Systems |
| bytes | 3.1.2 | MIT | Copyright (c) 2012-2014 TJ Holowaychuk <tj@vision-media.ca>; Copyright (c) 2015 Jed Watson <jed.watson@me.com> |
| call-bind-apply-helpers | 1.0.2 | MIT | Copyright (c) 2024 Jordan Harband |
| call-bound | 1.0.4 | MIT | Copyright (c) 2024 Jordan Harband |
| camelcase | 5.3.1 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| ccount | 2.0.1 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| character-entities | 2.0.2 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| character-entities-html4 | 2.1.0 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| character-entities-legacy | 3.0.0 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| character-reference-invalid | 2.0.1 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| chokidar | 5.0.0 | MIT | Copyright (c) 2012 Paul Miller (https://paulmillr.com), Elan Shanker |
| class-variance-authority | 0.7.1 | Apache-2.0 | Copyright 2022 Joe Bell |
| cliui | 6.0.0 | ISC | Copyright (c) 2015, Contributors |
| cliui | 8.0.1 | ISC | Copyright (c) 2015, Contributors |
| clsx | 2.1.1 | MIT | Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com) |
| cmdk | 1.1.1 | MIT | Copyright (c) 2022 Paco Coursey |
| codemirror | 6.0.2 | MIT | Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| collapse-white-space | 2.1.0 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| color-convert | 2.0.1 | MIT | Copyright (c) 2011-2016 Heather Arthur <fayearthur@gmail.com> |
| color-name | 1.1.4 | MIT | Copyright (c) 2015 Dmitry Ivanov |
| comma-separated-tokens | 2.0.3 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| commander | 7.2.0 | MIT | Copyright (c) 2011 TJ Holowaychuk <tj@vision-media.ca> |
| commander | 8.3.0 | MIT | Copyright (c) 2011 TJ Holowaychuk <tj@vision-media.ca> |
| content-disposition | 1.1.0 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson |
| content-type | 1.0.5 | MIT | Copyright (c) 2015 Douglas Christopher Wilson |
| content-type | 2.0.0 | MIT | Copyright (c) 2015 Douglas Christopher Wilson |
| convex | 1.49.0 | Apache-2.0 | Copyright 2026 Convex, Inc. |
| cookie | 0.7.2 | MIT | Copyright (c) 2012-2014 Roman Shtylman <shtylman@gmail.com>; Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com> |
| cookie-signature | 1.2.2 | MIT | Copyright (c) 2012–2024 LearnBoost <tj@learnboost.com> and other contributors; |
| core-util-is | 1.0.3 | MIT |  |
| cors | 2.8.6 | MIT | Copyright (c) 2013 Troy Goode <troygoode@gmail.com> |
| cose-base | 1.0.3 | MIT | Copyright (c) 2019 - present, iVis@Bilkent. |
| cose-base | 2.2.0 | MIT | Copyright (c) 2019 - present, iVis@Bilkent. |
| crelt | 1.0.7 | MIT | Copyright (C) 2020 by Marijn Haverbeke <marijn@haverbeke.berlin> |
| cross-spawn | 7.0.6 | MIT | Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio> |
| crossws | 0.4.17 | MIT | Copyright (c) Pooya Parsa <pooya@pi0.io>; Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>; Copyright (c) 2013 Arnout Kazemier and contributors; Copyright (c) 2016 Luigi Pinca and contributors |
| cuelume | 0.2.2 | MIT | Copyright (c) 2026 Daniel Belyi |
| cytoscape | 3.34.2 | MIT | Copyright (c) 2016-2026, The Cytoscape Consortium. |
| cytoscape-cose-bilkent | 4.1.0 | MIT | Copyright (c) 2016-2018, The Cytoscape Consortium. |
| cytoscape-fcose | 2.2.0 | MIT | Copyright (c) 2018 - present, iVis-at-Bilkent. |
| d3 | 7.9.0 | ISC | Copyright 2010-2023 Mike Bostock |
| d3-array | 2.12.1 | BSD-3-Clause | Copyright 2010-2020 Mike Bostock |
| d3-array | 3.2.4 | ISC | Copyright 2010-2023 Mike Bostock |
| d3-axis | 3.0.0 | ISC | Copyright 2010-2021 Mike Bostock |
| d3-brush | 3.0.0 | ISC | Copyright 2010-2021 Mike Bostock |
| d3-chord | 3.0.1 | ISC | Copyright 2010-2021 Mike Bostock |
| d3-color | 3.1.0 | ISC | Copyright 2010-2022 Mike Bostock |
| d3-contour | 4.0.2 | ISC | Copyright 2012-2023 Mike Bostock |
| d3-delaunay | 6.0.4 | ISC | Copyright 2018-2021 Observable, Inc.; Copyright 2021 Mapbox |
| d3-dispatch | 3.0.1 | ISC | Copyright 2010-2021 Mike Bostock |
| d3-drag | 3.0.0 | ISC | Copyright 2010-2021 Mike Bostock |
| d3-dsv | 3.0.1 | ISC | Copyright 2013-2021 Mike Bostock |
| d3-ease | 3.0.1 | BSD-3-Clause | Copyright 2010-2021 Mike Bostock; Copyright 2001 Robert Penner |
| d3-fetch | 3.0.1 | ISC | Copyright 2016-2021 Mike Bostock |
| d3-force | 3.0.0 | ISC | Copyright 2010-2021 Mike Bostock |
| d3-format | 3.1.2 | ISC | Copyright 2010-2026 Mike Bostock |
| d3-geo | 3.1.1 | ISC | Copyright 2010-2024 Mike Bostock; Copyright 2008-2012 Charles Karney |
| d3-hierarchy | 3.1.2 | ISC | Copyright 2010-2021 Mike Bostock |
| d3-interpolate | 3.0.1 | ISC | Copyright 2010-2021 Mike Bostock |
| d3-path | 1.0.9 | BSD-3-Clause | Copyright 2015-2016 Mike Bostock |
| d3-path | 3.1.0 | ISC | Copyright 2015-2022 Mike Bostock |
| d3-polygon | 3.0.1 | ISC | Copyright 2010-2021 Mike Bostock |
| d3-quadtree | 3.0.1 | ISC | Copyright 2010-2021 Mike Bostock |
| d3-random | 3.0.1 | ISC | Copyright 2010-2021 Mike Bostock |
| d3-sankey | 0.12.3 | BSD-3-Clause | Copyright 2015, Mike Bostock |
| d3-scale | 4.0.2 | ISC | Copyright 2010-2021 Mike Bostock |
| d3-scale-chromatic | 3.1.0 | ISC | Copyright 2010-2024 Mike Bostock; Copyright 2002 Cynthia Brewer, Mark Harrower, and The Pennsylvania State University |
| d3-selection | 3.0.0 | ISC | Copyright 2010-2021 Mike Bostock |
| d3-shape | 1.3.7 | BSD-3-Clause | Copyright 2010-2015 Mike Bostock |
| d3-shape | 3.2.0 | ISC | Copyright 2010-2022 Mike Bostock |
| d3-time | 3.1.0 | ISC | Copyright 2010-2022 Mike Bostock |
| d3-time-format | 4.1.0 | ISC | Copyright 2010-2021 Mike Bostock |
| d3-timer | 3.0.1 | ISC | Copyright 2010-2021 Mike Bostock |
| d3-transition | 3.0.1 | ISC | Copyright 2010-2021 Mike Bostock |
| d3-zoom | 3.0.0 | ISC | Copyright 2010-2021 Mike Bostock |
| dagre-d3-es | 7.0.14 | MIT | Copyright (c) 2022-2024 Thibaut Lassalle, David Newell, Alois Klink, Sidharth Vinod and dagre-es contributors |
| date-fns | 4.4.0 | MIT | Copyright (c) 2021 Sasha Koss and Lesha Koss https://kossnocorp.mit-license.org |
| dayjs | 1.11.23 | MIT | Copyright (c) 2018-present, iamkun |
| debug | 4.4.3 | MIT | Copyright (c) 2014-2017 TJ Holowaychuk <tj@vision-media.ca>; Copyright (c) 2018-2021 Josh Junon |
| decamelize | 1.2.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| decimal.js | 10.6.0 | MIT | Copyright (c) 2025 Michael Mclaughlin |
| decimal.js-light | 2.5.1 | MIT | Copyright (c) 2020 Michael Mclaughlin |
| decode-named-character-reference | 1.3.0 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| delaunator | 5.1.0 | ISC | Copyright (c) 2026, Mapbox |
| depd | 2.0.0 | MIT | Copyright (c) 2014-2018 Douglas Christopher Wilson |
| dequal | 2.0.3 | MIT | Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com) |
| detect-libc | 2.1.2 | Apache-2.0 |  |
| detect-node-es | 1.1.0 | MIT | Copyright (c) 2017 Ilya Kantor |
| devlop | 1.1.0 | MIT | Copyright (c) 2023 Titus Wormer <tituswormer@gmail.com> |
| dijkstrajs | 1.0.3 | MIT | Copyright (C) 2008 |
| docx | 9.15.4 | MIT | Copyright (c) 2016 Dolan |
| dompurify | 3.4.18 | MPL-2.0 OR Apache-2.0 |  |
| dompurify | 3.4.8 | MPL-2.0 OR Apache-2.0 |  |
| dunder-proto | 1.0.1 | MIT | Copyright (c) 2024 ECMAScript Shims |
| ee-first | 1.1.1 | MIT | Copyright (c) 2014 Jonathan Ong me@jongleberry.com |
| electron-updater | 6.8.9 | MIT | Copyright (c) 2015 Loopline Systems |
| emoji-regex | 8.0.0 | MIT |  |
| encodeurl | 2.0.0 | MIT | Copyright (c) 2016 Douglas Christopher Wilson |
| enhanced-resolve | 5.24.5 | MIT |  |
| entities | 6.0.1 | BSD-2-Clause | Copyright (c) Felix Böhm |
| es-define-property | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband |
| es-errors | 1.3.0 | MIT | Copyright (c) 2024 Jordan Harband |
| es-object-atoms | 1.1.2 | MIT | Copyright (c) 2024 Jordan Harband |
| es-toolkit | 1.52.0 | MIT | Copyright (c) 2024 Viva Republica, Inc. |
| esbuild | 0.27.0 | MIT | Copyright (c) 2020 Evan Wallace |
| escalade | 3.2.0 | MIT | Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com) |
| escape-html | 1.0.3 | MIT | Copyright (c) 2012-2013 TJ Holowaychuk; Copyright (c) 2015 Andreas Lubbe; Copyright (c) 2015 Tiancheng "Timothy" Gu |
| escape-string-regexp | 5.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |
| estree-util-is-identifier-name | 3.0.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| etag | 1.8.1 | MIT | Copyright (c) 2014-2016 Douglas Christopher Wilson |
| eventemitter3 | 5.0.4 | MIT | Copyright (c) 2014 Arnout Kazemier |
| eventsource | 3.0.7 | MIT | Copyright (c) EventSource GitHub organisation |
| eventsource-parser | 3.1.1 | MIT | Copyright (c) 2026 Espen Hovlandsdal <espen@hovlandsdal.com> |
| express | 5.2.1 | MIT | Copyright (c) 2009-2014 TJ Holowaychuk <tj@vision-media.ca>; Copyright (c) 2013-2014 Roman Shtylman <shtylman+expressjs@gmail.com>; Copyright (c) 2014-2015 Douglas Christopher Wilson <doug@somethingdoug.com> |
| express-rate-limit | 8.6.2 | MIT | Copyright 2023 Nathan Friedly, Vedant K |
| extend | 3.0.2 | MIT | Copyright (c) 2014 Stefan Thomas |
| fast-deep-equal | 3.1.3 | MIT | Copyright (c) 2017 Evgeny Poberezkin |
| fast-diff | 1.3.0 | Apache-2.0 | Copyright 2014-2023 Jason Chen |
| fast-equals | 5.4.5 | MIT | Copyright (c) 2025 Tony Quetano |
| fast-uri | 3.1.5 | BSD-3-Clause | Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae; Copyright (c) 2021-present The Fastify team <https://github.com/fastify/fastify#team> |
| fastdom | 1.0.12 | MIT |  |
| fdir | 6.5.0 | MIT | Copyright 2023 Abdullah Atta |
| fflate | 0.8.2 | MIT | Copyright (c) 2023 Arjun Barrett |
| fflate | 0.8.3 | MIT | Copyright (c) 2026 Arjun Barrett |
| finalhandler | 2.1.1 | MIT | Copyright (c) 2014-2022 Douglas Christopher Wilson <doug@somethingdoug.com> |
| find-up | 4.1.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| forwarded | 0.2.0 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson |
| framer-motion | 13.2.0 | MIT | Copyright (c) 2018 Framer B.V. |
| franc-min | 6.2.0 | MIT |  |
| fresh | 2.0.0 | MIT | Copyright (c) 2012 TJ Holowaychuk <tj@vision-media.ca>; Copyright (c) 2016-2017 Douglas Christopher Wilson <doug@somethingdoug.com> |
| frimousse | 0.4.0 | MIT | Copyright (c) 2025 Liveblocks |
| fs-extra | 10.1.0 | MIT | Copyright (c) 2011-2017 JP Richardson |
| function-bind | 1.1.2 | MIT | Copyright (c) 2013 Raynos. |
| get-caller-file | 2.0.5 | ISC | Copyright 2018 Stefan Penner |
| get-intrinsic | 1.3.0 | MIT | Copyright (c) 2020 Jordan Harband |
| get-nonce | 1.0.1 | MIT | Copyright (c) 2020 Anton Korzunov |
| get-proto | 1.0.1 | MIT | Copyright (c) 2025 Jordan Harband |
| gopd | 1.2.0 | MIT | Copyright (c) 2022 Jordan Harband |
| graceful-fs | 4.2.11 | ISC | Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors |
| hachure-fill | 0.5.2 | MIT | Copyright (c) 2023 Preet Shihn |
| has-symbols | 1.1.0 | MIT | Copyright (c) 2016 Jordan Harband |
| hasown | 2.0.4 | MIT | Copyright (c) Jordan Harband and contributors |
| hast-util-from-parse5 | 8.0.3 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| hast-util-parse-selector | 4.0.0 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| hast-util-raw | 9.1.0 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| hast-util-sanitize | 5.0.2 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| hast-util-to-html | 9.0.5 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| hast-util-to-jsx-runtime | 2.3.6 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| hast-util-to-parse5 | 8.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| hast-util-whitespace | 3.0.0 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| hastscript | 9.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| hono | 4.13.1 | MIT | Copyright (c) 2021 - present, Yusuke Wada and Hono contributors |
| html-url-attributes | 3.0.1 | MIT | Copyright (c) Titus Wormer |
| html-void-elements | 3.0.0 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| http-errors | 2.0.1 | MIT | Copyright (c) 2014 Jonathan Ong me@jongleberry.com; Copyright (c) 2016 Douglas Christopher Wilson doug@somethingdoug.com |
| https | 1.0.0 | ISC |  |
| iconv-lite | 0.6.3 | MIT | Copyright (c) 2011 Alexander Shtuchkin |
| iconv-lite | 0.7.3 | MIT | Copyright (c) 2011 Alexander Shtuchkin |
| image-size | 1.2.1 | MIT | Copyright © 2013-Present Aditya Yadav, http://netroy.in |
| immediate | 3.0.6 | MIT | Copyright (c) 2012 Barnesandnoble.com, llc, Donavon West, Domenic Denicola, Brian Cavalier |
| immer | 11.1.21 | MIT | Copyright (c) 2017 Michel Weststrate |
| import-meta-resolve | 4.2.0 | MIT | Copyright (c) Titus Wormer <mailto:tituswormer@gmail.com> |
| inherits | 2.0.4 | ISC | Copyright (c) Isaac Z. Schlueter |
| inline-style-parser | 0.2.7 | MIT | Copyright (c) 2012 TJ Holowaychuk <tj@vision-media.ca> |
| internmap | 1.0.1 | ISC | Copyright 2021 Mike Bostock |
| internmap | 2.0.3 | ISC | Copyright 2021 Mike Bostock |
| ip-address | 10.5.0 | MIT | Copyright (C) 2011 by Beau Gunderson |
| ipaddr.js | 1.9.1 | MIT | Copyright (C) 2011-2017 whitequark <whitequark@whitequark.org> |
| is-alphabetical | 2.0.1 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| is-alphanumerical | 2.0.1 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| is-decimal | 2.0.1 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| is-fullwidth-code-point | 3.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| is-hexadecimal | 2.0.1 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| is-plain-obj | 4.1.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |
| is-promise | 4.0.0 | MIT | Copyright (c) 2014 Forbes Lindesay |
| isarray | 1.0.0 | MIT |  |
| isexe | 2.0.0 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| isomorphic.js | 0.2.5 | MIT | Copyright (c) 2020 Kevin Jahns <kevin.jahns@protonmail.com>. |
| jiti | 2.7.0 | MIT | Copyright (c) Pooya Parsa <pooya@pi0.io> |
| jose | 6.2.8 | MIT | Copyright (c) 2018 Filip Skokan |
| js-yaml | 4.3.1 | MIT | Copyright (C) 2011-2015 by Vitaly Puzrin |
| json-schema-traverse | 1.0.0 | MIT | Copyright (c) 2017 Evgeny Poberezkin |
| json-schema-typed | 8.0.2 | BSD-2-Clause |  |
| jsonc-parser | 3.3.1 | MIT | Copyright (c) Microsoft |
| jsonfile | 6.2.1 | MIT | Copyright (c) 2012-2015, JP Richardson <jprichardson@gmail.com> |
| jszip | 3.10.2 | MIT OR GPL-3.0-or-later | Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso; Copyright (C) 2007 Free Software Foundation, Inc. <http://fsf.org/> |
| katex | 0.16.47 | MIT | Copyright (c) 2013-2020 Khan Academy and other contributors |
| kdbush | 4.1.0 | ISC | Copyright (c) 2026, Vladimir Agafonkin |
| khroma | 2.1.0 | MIT | Copyright (c) 2019-present Fabio Spampinato, Andrew Maney |
| kleur | 4.1.5 | MIT | Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com) |
| layout-base | 1.0.2 | MIT | Copyright (c) 2019 iVis@Bilkent |
| layout-base | 2.0.1 | MIT | Copyright (c) 2019 iVis@Bilkent |
| lazy-val | 1.0.5 | MIT |  |
| lib0 | 0.2.120 | MIT | Copyright (c) 2019 Kevin Jahns <kevin.jahns@protonmail.com>. |
| lib0 | 1.0.0-rc.36 | MIT | Copyright (c) 2019 Kevin Jahns <kevin.jahns@protonmail.com>. |
| lie | 3.3.0 | MIT |  |
| lightningcss | 1.32.0 | MPL-2.0 | (c) under Patent Claims infringed by Covered Software in the absence of |
| linkifyjs | 4.4.0 | MIT | Copyright (c) 2024 Nick Frasser |
| locate-path | 5.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| lodash-es | 4.18.1 | MIT |  |
| lodash.camelcase | 4.3.0 | MIT |  |
| lodash.escaperegexp | 4.1.2 | MIT |  |
| lodash.isequal | 4.5.0 | MIT |  |
| long | 5.3.2 | Apache-2.0 |  |
| longest-streak | 3.1.0 | MIT | Copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com> |
| lru-cache | 6.0.0 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| lucide-react | 0.525.0 | ISC | Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022. |
| magic-string | 0.30.21 | MIT | Copyright 2018 Rich Harris |
| markdown-table | 3.0.4 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| marked | 14.0.0 | MIT | Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/); Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/); Copyright © 2004, John Gruber |
| marked | 16.4.2 | MIT | Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/); Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/); Copyright © 2004, John Gruber |
| marked | 17.0.6 | MIT | Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/); Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/); Copyright © 2004, John Gruber |
| math-intrinsics | 1.1.0 | MIT | Copyright (c) 2024 ECMAScript Shims |
| mdast-util-find-and-replace | 3.0.2 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| mdast-util-from-markdown | 2.0.3 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| mdast-util-gfm | 3.1.0 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| mdast-util-gfm-autolink-literal | 2.0.1 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| mdast-util-gfm-footnote | 2.1.0 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| mdast-util-gfm-strikethrough | 2.0.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| mdast-util-gfm-table | 2.0.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| mdast-util-gfm-task-list-item | 2.0.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| mdast-util-mdx-expression | 2.0.1 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| mdast-util-mdx-jsx | 3.2.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| mdast-util-mdxjs-esm | 2.0.1 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| mdast-util-phrasing | 4.1.0 | MIT | Copyright (c) 2017 Titus Wormer <tituswormer@gmail.com>; Copyright (c) 2017 Victor Felder <victor@draft.li> |
| mdast-util-to-hast | 13.2.1 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| mdast-util-to-markdown | 2.1.2 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| mdast-util-to-string | 4.0.0 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| media-typer | 1.1.1 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson |
| merge-descriptors | 2.0.0 | MIT | Copyright (c) Jonathan Ong <me@jongleberry.com>; Copyright (c) Douglas Christopher Wilson <doug@somethingdoug.com>; Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |
| mermaid | 11.17.2 | MIT | Copyright (c) 2014 - 2022 Knut Sveidqvist |
| micromark | 4.0.2 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-core-commonmark | 2.0.3 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-extension-gfm | 3.0.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| micromark-extension-gfm-autolink-literal | 2.1.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| micromark-extension-gfm-footnote | 2.1.0 | MIT | Copyright (c) 2021 Titus Wormer <tituswormer@gmail.com> |
| micromark-extension-gfm-strikethrough | 2.1.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| micromark-extension-gfm-table | 2.1.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-extension-gfm-tagfilter | 2.0.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| micromark-extension-gfm-task-list-item | 2.1.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| micromark-factory-destination | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-factory-label | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-factory-space | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-factory-title | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-factory-whitespace | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-character | 2.1.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-chunked | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-classify-character | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-combine-extensions | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-decode-numeric-character-reference | 2.0.2 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-decode-string | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-encode | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-html-tag-name | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-normalize-identifier | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-resolve-all | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-sanitize-uri | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-subtokenize | 2.1.0 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-symbol | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-types | 2.0.2 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| mime-db | 1.54.0 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2015-2022 Douglas Christopher Wilson <doug@somethingdoug.com> |
| mime-types | 3.0.2 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com> |
| monaco-editor | 0.56.0 | MIT | Copyright (c) 2016 - present Microsoft Corporation |
| motion | 13.2.0 | MIT | Copyright (c) 2024 [Motion](https://motion.dev) B.V. |
| motion-dom | 13.2.0 | MIT | Copyright (c) 2024 [Motion](https://motion.dev) B.V. |
| motion-utils | 13.0.0 | MIT | Copyright (c) 2024 [Motion](https://motion.dev) B.V. |
| ms | 2.1.3 | MIT | Copyright (c) 2020 Vercel, Inc. |
| n-gram | 2.0.2 | MIT | Copyright (c) 2014 Titus Wormer <tituswormer@gmail.com> |
| nanoid | 6.0.1 | MIT | Copyright 2017 Andrey Sitnik <andrey@sitnik.es> |
| negotiator | 1.0.0 | MIT | Copyright (c) 2012-2014 Federico Romero; Copyright (c) 2012-2014 Isaac Z. Schlueter; Copyright (c) 2014-2015 Douglas Christopher Wilson |
| node-addon-api | 7.1.1 | MIT | Copyright (c) 2017 [Node.js API collaborators](https://github.com/nodejs/node-addon-api#collaborators) |
| node-pty | 1.1.0 | MIT | Copyright (c) 2012-2015, Christopher Jeffrey (https://github.com/chjj/); Copyright (c) 2016, Daniel Imms (http://www.growingwiththeweb.com); Copyright (c) 2018 - present Microsoft Corporation |
| object-assign | 4.1.1 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| object-inspect | 1.13.4 | MIT | Copyright (c) 2013 James Halliday |
| on-finished | 2.4.1 | MIT | Copyright (c) 2013 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2014 Douglas Christopher Wilson <doug@somethingdoug.com> |
| once | 1.4.0 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| oniguruma-parser | 0.12.2 | MIT | Copyright (c) 2025-2026 Steven Levithan |
| oniguruma-to-es | 4.3.6 | MIT | Copyright (c) 2024-2026 Steven Levithan |
| orderedmap | 2.1.1 | MIT | Copyright (C) 2016 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| ot-json1 | 1.0.2 | ISC |  |
| ot-text-unicode | 4.0.0 | ISC |  |
| p-limit | 2.3.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| p-locate | 4.1.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| p-try | 2.2.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| package-manager-detector | 1.8.0 | MIT | Copyright (c) 2020-PRESENT Anthony Fu <https://github.com/antfu> |
| pako | 1.0.11 | MIT AND Zlib | Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn |
| parse-entities | 4.0.2 | MIT | Copyright (c) Titus Wormer <mailto:tituswormer@gmail.com> |
| parse5 | 7.3.0 | MIT | Copyright (c) 2013-2019 Ivan Nikulin (ifaaan@gmail.com, https://github.com/inikulin) |
| parseurl | 1.3.3 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2014-2017 Douglas Christopher Wilson <doug@somethingdoug.com> |
| path-data-parser | 0.1.0 | MIT | Copyright (c) 2020 Preet Shihn |
| path-exists | 4.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| path-key | 3.1.1 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| path-to-regexp | 8.4.2 | MIT | Copyright (c) 2014 Blake Embrey (hello@blakeembrey.com) |
| pdf-lib | 1.17.1 | MIT | Copyright (c) 2019 Andrew Dillon |
| pdfjs-dist | 6.5.438 | Apache-2.0 |  |
| picomatch | 4.0.5 | MIT | Copyright (c) 2017-present, Jon Schlinkert. |
| pkce-challenge | 5.0.1 | MIT | Copyright (c) 2019 |
| pngjs | 5.0.0 | MIT |  |
| points-on-curve | 0.2.0 | MIT | Copyright (c) 2020 Preet Shihn |
| points-on-path | 0.2.1 | MIT | Copyright (c) 2020 Preet |
| pptxgenjs | 4.0.1 | MIT | Copyright (c) 2015-2022 Brent Ely |
| prettier | 3.9.6 | MIT | Copyright © James Long and contributors |
| process-nextick-args | 2.0.1 | MIT |  |
| property-information | 7.2.0 | MIT | Copyright (c) Titus Wormer <mailto:tituswormer@gmail.com> |
| prosemirror-changeset | 2.4.6 | MIT | Copyright (C) 2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| prosemirror-commands | 1.7.2 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| prosemirror-dropcursor | 1.8.4 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| prosemirror-gapcursor | 1.4.1 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| prosemirror-highlight | 0.15.3 | MIT | Copyright (c) 2022 ocavue |
| prosemirror-history | 1.5.1 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| prosemirror-inputrules | 1.6.0 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| prosemirror-keymap | 1.2.3 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| prosemirror-model | 1.25.13 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| prosemirror-schema-list | 1.6.0 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| prosemirror-state | 1.4.4 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| prosemirror-tables | 1.8.5 | MIT | Copyright (C) 2015-2016 by Marijn Haverbeke <marijnh@gmail.com> and others |
| prosemirror-transform | 1.12.6 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| prosemirror-view | 1.42.9 | MIT | Copyright (C) 2015-2017 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| protobufjs | 7.6.6 | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz All rights reserved. |
| proxy-addr | 2.0.7 | MIT | Copyright (c) 2014-2016 Douglas Christopher Wilson |
| qrcode | 1.5.4 | MIT | Copyright (c) 2012 Ryan Day |
| qs | 6.15.3 | BSD-3-Clause | Copyright (c) 2014, Nathan LaFreniere and other [contributors](https://github.com/ljharb/qs/graphs/contributors) |
| queue | 6.0.2 | MIT | Copyright (c) 2014 Jesse Tane <jesse.tane@gmail.com> |
| quickselect | 3.0.0 | ISC | Copyright (c) 2024, Vladimir Agafonkin |
| range-parser | 1.3.0 | MIT | Copyright (c) 2012-2014 TJ Holowaychuk <tj@vision-media.ca>; Copyright (c) 2015-2016 Douglas Christopher Wilson <doug@somethingdoug.com |
| raw-body | 3.0.2 | MIT | Copyright (c) 2013-2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2014-2022 Douglas Christopher Wilson <doug@somethingdoug.com> |
| rbush | 4.0.1 | MIT | Copyright (c) 2024 Volodymyr Agafonkin |
| react | 19.3.1 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| react-day-picker | 10.0.2 | MIT | Copyright (c) 2014-2026 Giampaolo Bellavite <io@gpbl.dev> and contributors |
| react-dom | 19.3.1 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| react-material-icon-theme | 1.2.0 | MIT | Copyright (c) 2025 Qalxry |
| react-redux | 9.3.0 | MIT | Copyright (c) 2015-present Dan Abramov |
| react-remove-scroll | 2.7.2 | MIT | Copyright (c) 2017 Anton Korzunov |
| react-remove-scroll-bar | 2.3.8 | MIT |  |
| react-style-singleton | 2.2.3 | MIT | Copyright (c) 2017 Anton Korzunov |
| readable-stream | 2.3.8 | MIT |  |
| readdirp | 5.1.1 | MIT | Copyright (c) 2012-2019 Thorsten Lorenz, Paul Miller (https://paulmillr.com) |
| recharts | 3.10.1 | MIT | Copyright (c) 2015-present recharts |
| redux | 5.0.1 | MIT | Copyright (c) 2015-present Dan Abramov |
| redux-thunk | 3.1.0 | MIT | Copyright (c) 2015-present Dan Abramov |
| regex | 6.1.0 | MIT | Copyright (c) 2025 Steven Levithan |
| regex-recursion | 6.0.2 | MIT | Copyright (c) 2025 Steven Levithan |
| regex-utilities | 2.3.0 | MIT | Copyright (c) 2024 Steven Levithan |
| rehype-harden | 1.1.8 | MIT | Copyright (c) 2025 Vercel Inc. |
| rehype-raw | 7.0.0 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| rehype-sanitize | 6.0.0 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| remark-gfm | 4.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| remark-parse | 11.0.0 | MIT | Copyright (c) 2014 Titus Wormer <tituswormer@gmail.com> |
| remark-rehype | 11.1.2 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| remark-stringify | 11.0.0 | MIT | Copyright (c) 2014 Titus Wormer <tituswormer@gmail.com> |
| remend | 1.3.1 | Apache-2.0 | Copyright 2023 Vercel, Inc. |
| require-directory | 2.1.1 | MIT | Copyright (c) 2011 Troy Goode <troygoode@gmail.com> |
| require-from-string | 2.0.2 | MIT | Copyright (c) Vsevolod Strukchinsky <floatdrop@gmail.com> (github.com/floatdrop) |
| require-main-filename | 2.0.0 | ISC | Copyright (c) 2016, Contributors |
| reselect | 5.2.0 | MIT | Copyright (c) 2015-2018 Reselect Contributors |
| reselect | 5.3.0 | MIT | Copyright (c) 2015-2018 Reselect Contributors |
| robust-predicates | 3.0.3 | Unlicense |  |
| rope-sequence | 1.3.4 | MIT | Copyright (C) 2016 by Marijn Haverbeke <marijn@haverbeke.berlin> |
| roughjs | 4.6.6 | MIT | Copyright (c) 2019 Preet Shihn |
| router | 2.2.0 | MIT | Copyright (c) 2013 Roman Shtylman; Copyright (c) 2014-2022 Douglas Christopher Wilson |
| rw | 1.3.3 | BSD-3-Clause | Copyright (c) 2014-2016, Michael Bostock |
| safe-buffer | 5.1.2 | MIT | Copyright (c) Feross Aboukhadijeh |
| safer-buffer | 2.1.2 | MIT | Copyright (c) 2018 Nikita Skovoroda <chalkerx@gmail.com> |
| sax | 1.6.1 | BlueOak-1.0.0 |  |
| scheduler | 0.28.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| semver | 7.5.2 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| semver | 7.7.4 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| send | 1.2.1 | MIT | Copyright (c) 2012 TJ Holowaychuk; Copyright (c) 2014-2022 Douglas Christopher Wilson |
| serve-static | 2.2.1 | MIT | Copyright (c) 2010 Sencha Inc.; Copyright (c) 2011 LearnBoost; Copyright (c) 2011 TJ Holowaychuk; Copyright (c) 2014-2016 Douglas Christopher Wilson |
| set-blocking | 2.0.0 | ISC | Copyright (c) 2016, Contributors |
| setimmediate | 1.0.5 | MIT | Copyright (c) 2012 Barnesandnoble.com, llc, Donavon West, and Domenic Denicola |
| setprototypeof | 1.2.0 | ISC | Copyright (c) 2015, Wes Todd |
| shebang-command | 2.0.0 | MIT | Copyright (c) Kevin Mårtensson <kevinmartensson@gmail.com> (github.com/kevva) |
| shebang-regex | 3.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| shiki | 3.23.0 | MIT | Copyright (c) 2021 Pine Wu; Copyright (c) 2023 Anthony Fu <https://github.com/antfu> |
| side-channel | 1.1.1 | MIT | Copyright (c) 2019 Jordan Harband |
| side-channel-list | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband |
| side-channel-map | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband |
| side-channel-weakmap | 1.0.2 | MIT | Copyright (c) 2019 Jordan Harband |
| simple-icons | 16.30.0 | CC0-1.0 |  |
| sonner | 2.0.8 | MIT | Copyright (c) 2023 Emil Kowalski |
| source-map-js | 1.2.1 | BSD-3-Clause | Copyright (c) 2009-2011, Mozilla Foundation and contributors |
| space-separated-tokens | 2.0.2 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| statuses | 2.0.2 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2016 Douglas Christopher Wilson <doug@somethingdoug.com> |
| streamdown | 2.6.0 | Apache-2.0 | Copyright 2023 Vercel, Inc. |
| strictdom | 1.0.1 | MIT |  |
| string_decoder | 1.1.1 | MIT |  |
| string-width | 4.2.3 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| stringify-entities | 4.0.4 | MIT | Copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com> |
| strip-ansi | 6.0.1 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| style-mod | 4.1.3 | MIT | Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| style-to-js | 1.1.21 | MIT | Copyright (c) 2020 Menglin "Mark" Xu <mark@remarkablemark.org> |
| style-to-object | 1.0.14 | MIT | Copyright (c) 2017 Menglin "Mark" Xu <mark@remarkablemark.org> |
| stylis | 4.4.0 | MIT | Copyright (c) 2016-present Sultan Tarimo |
| tabbable | 6.5.2 | MIT | Copyright (c) 2015 David Clark |
| tailwind-merge | 2.6.2 | MIT | Copyright (c) 2021 Dany Castillo |
| tailwind-merge | 3.6.0 | MIT | Copyright (c) 2021 Dany Castillo |
| tailwindcss | 4.3.3 | MIT | Copyright (c) Tailwind Labs, Inc. |
| tapable | 2.3.3 | MIT |  |
| tiny-invariant | 1.3.3 | MIT | Copyright (c) 2019 Alexander Reardon |
| tiny-typed-emitter | 2.1.0 | MIT | Copyright (c) 2020 Zurab Benashvili (binier) <zura.bena@gmail.com> |
| tinyexec | 1.3.1 | MIT | Copyright (c) 2024 Tinylibs |
| tinyglobby | 0.2.17 | MIT | Copyright (c) 2024 Madeline Gurriarán |
| toidentifier | 1.0.1 | MIT | Copyright (c) 2016 Douglas Christopher Wilson <doug@somethingdoug.com> |
| torph | 0.1.4 | MIT | Copyright (c) 2025 Lochie Axon |
| trigram-utils | 2.0.1 | MIT | Copyright (c) 2014 Titus Wormer <tituswormer@gmail.com> |
| trim-lines | 3.0.1 | MIT | Copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com> |
| trough | 2.2.0 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| ts-dedent | 2.3.0 | MIT | Copyright (c) 2018 Tamino Martinius |
| tslib | 1.14.1 | 0BSD | Copyright (c) Microsoft Corporation. |
| tslib | 2.8.1 | 0BSD | Copyright (c) Microsoft Corporation. |
| tw-animate-css | 1.4.0 | MIT | Copyright (c) 2025 Wombosvideo |
| type-is | 2.1.0 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>; Copyright (c) 2014-2015 Douglas Christopher Wilson <doug@somethingdoug.com> |
| typescript | 5.9.3 | Apache-2.0 |  |
| undici | 8.10.2 | MIT | Copyright (c) Matteo Collina and Undici contributors |
| undici-types | 6.21.0 | MIT | Copyright (c) Matteo Collina and Undici contributors |
| undici-types | 8.9.0 | MIT | Copyright (c) Matteo Collina and Undici contributors |
| unicount | 1.1.0 | ISC |  |
| unified | 11.0.5 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| unist-util-is | 6.0.1 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| unist-util-position | 5.0.0 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| unist-util-stringify-position | 4.0.0 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| unist-util-visit | 5.1.0 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| unist-util-visit-parents | 6.0.2 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| universalify | 2.0.1 | MIT | Copyright (c) 2017, Ryan Zimmerman <opensrc@ryanzim.com> |
| unpipe | 1.0.0 | MIT | Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com> |
| use-callback-ref | 1.3.3 | MIT | Copyright (c) 2017 Anton Korzunov |
| use-sidecar | 1.1.3 | MIT | Copyright (c) 2017 Anton Korzunov |
| use-sync-external-store | 1.6.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| use-sync-external-store | 1.7.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| util-deprecate | 1.0.2 | MIT | Copyright (c) 2014 Nathan Rajlich <nathan@tootallnate.net> |
| uuid | 14.0.2 | MIT | Copyright (c) 2010-2020 Robert Kieffer and other contributors |
| vary | 1.1.2 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson |
| vfile | 6.0.3 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| vfile-location | 5.0.3 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| vfile-message | 4.0.3 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| victory-vendor | 37.3.6 | MIT AND ISC |  |
| vscode-jsonrpc | 8.2.0 | MIT | Copyright (c) Microsoft Corporation |
| vscode-languageserver | 9.0.1 | MIT | Copyright (c) Microsoft Corporation |
| vscode-languageserver-protocol | 3.17.5 | MIT | Copyright (c) Microsoft Corporation |
| vscode-languageserver-textdocument | 1.0.12 | MIT | Copyright (c) Microsoft Corporation |
| vscode-languageserver-types | 3.17.5 | MIT | Copyright (c) Microsoft Corporation |
| vscode-uri | 3.1.0 | MIT | Copyright (c) Microsoft |
| w3c-keyname | 2.2.8 | MIT | Copyright (C) 2016 by Marijn Haverbeke <marijn@haverbeke.berlin> and others |
| web-namespaces | 2.0.1 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| which | 2.0.2 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| which-module | 2.0.1 | ISC | Copyright (c) 2016, Contributors |
| work-kit | 0.0.0 | UNKNOWN |  |
| wrap-ansi | 6.2.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| wrap-ansi | 7.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |
| wrappy | 1.0.2 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| ws | 8.21.0 | MIT | Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>; Copyright (c) 2013 Arnout Kazemier and contributors; Copyright (c) 2016 Luigi Pinca and contributors |
| ws | 8.21.3 | MIT | Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>; Copyright (c) 2013 Arnout Kazemier and contributors; Copyright (c) 2016 Luigi Pinca and contributors |
| y-indexeddb | 9.0.12 | MIT | Copyright (c) 2014 |
| y-prosemirror | 1.3.7 | MIT | Copyright (c) 2019 Kevin Jahns <kevin.jahns@protonmail.com>. |
| y-protocols | 1.0.7 | MIT | Copyright (c) 2019 Kevin Jahns <kevin.jahns@protonmail.com>. |
| y18n | 4.0.3 | ISC | Copyright (c) 2015, Contributors |
| y18n | 5.0.8 | ISC | Copyright (c) 2015, Contributors |
| yallist | 4.0.0 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors |
| yargs | 15.4.1 | MIT | Copyright 2010 James Halliday (mail@substack.net); Modified work Copyright 2014 Contributors (ben@npmjs.com) |
| yargs | 17.7.3 | MIT | Copyright 2010 James Halliday (mail@substack.net); Modified work Copyright 2014 Contributors (ben@npmjs.com) |
| yargs-parser | 18.1.3 | ISC | Copyright (c) 2016, Contributors |
| yargs-parser | 21.1.1 | ISC | Copyright (c) 2016, Contributors |
| zod | 4.4.3 | MIT | Copyright (c) 2025 Colin McDonnell |
| zod-to-json-schema | 3.25.2 | ISC | Copyright (c) 2020, Stefan Terdell |
| zustand | 5.0.15 | MIT | Copyright (c) 2019 Paul Henschel |
| zwitch | 2.0.4 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |

## NOTICE files

As Apache-2.0 asks, each NOTICE a shipped package carries, as it is.

### @blocknote/core 0.57.0

```text
BlockNote Core Third-Party Notices

Emojibase data
--------------

The generated emoji data under src/emoji-data/frimousse includes data
derived from emojibase-data:

https://github.com/milesj/emojibase

MIT License

Copyright (c) 2017-2019 Miles Johnson

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

iamcal emoji-data shortcodes
----------------------------

The shared emoji data includes legacy shortcodes from iamcal/emoji-data,
distributed through emojibase-data/en/shortcodes/iamcal.json:

https://github.com/iamcal/emoji-data

The MIT License (MIT)

Copyright (c) 2013 Cal Henderson

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

Unicode CLDR annotation data
----------------------------

The generated emoji locale data under src/emoji-data/frimousse includes
annotations derived from Unicode CLDR 48.2.0. The source is the Unicode
Consortium's unicode-org/cldr-json repository:

https://github.com/unicode-org/cldr-json

The CLDR annotation data is licensed under the Unicode License V3:

Copyright © 1991-2025 Unicode, Inc.

Unicode License V3

Permission is hereby granted, free of charge, to any person obtaining a copy
of the Unicode Data files and associated documentation (the "Data Files") or
Unicode software and associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, and/or sell copies
of the Data Files or Software, and to permit persons to whom the Data Files or
Software are furnished to do so, provided that either (a) this copyright and
permission notice appear with all copies of the Data Files or Software, or (b)
this copyright and permission notice appear in associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS
INCLUDED IN THIS NOTICE BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR
CONSEQUENTIAL DAMAGES, OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE,
DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
OF THE DATA FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall not
be used in advertising or otherwise to promote the sale, use or other dealings
in these Data Files or Software without prior written authorization of the
copyright holder.
```

### es-toolkit 1.52.0

```text
es-toolkit

Parts of the test suite and compatibility layer in es-toolkit/compat are
derived from Lodash (https://github.com/lodash/lodash).

Lodash copyright notice and MIT permission notice:

Copyright OpenJS Foundation and other contributors <https://openjsf.org/>

Based on Underscore.js, copyright Jeremy Ashkenas,
DocumentCloud and Investigative Reporters & Editors <http://underscorejs.org/>

This software consists of voluntary contributions made by many
individuals. For exact contribution history, see the revision history
available at https://github.com/lodash/lodash

The following license applies to all parts of this software except as
documented below:

====

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Licence texts

Each package's full licence is in its folder under the app's `node_modules`. The texts most of them use:

### Apache-2.0

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```

### MIT

```text
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
