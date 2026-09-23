# Third-party notices

routy is licensed under the MIT License (see [LICENSE](./LICENSE)). It includes
code ported from the MIT-licensed projects below. Their notices are reproduced
here because the MIT License requires the copyright notice and permission notice
to accompany all copies or substantial portions of the software.

---

## 9Router

Ported into `routy-core/core/translate/` (69 files) and `routy-core/core/rtk/`
(17 files) — the request/response format translators and the tool-result
compressor. Individual files carry a header naming the upstream file they came
from. Adapted, not vendored: the port keeps the behaviour and the fixtures, and
rewrites the surrounding runtime (streaming, pooling, error handling).

```
MIT License

Copyright (c) 2024-2026 decolua and contributors

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
```

---

## Dependencies

Runtime and development dependencies are declared in `routy-core/package.json`
and `routy-ui/package.json`. Each ships its own licence in `node_modules/`, and
none of their code is redistributed in this repository. The published bundle
(`routy-core/dist/routy.mjs`) inlines `undici`; its MIT licence is preserved in
the generated file.
