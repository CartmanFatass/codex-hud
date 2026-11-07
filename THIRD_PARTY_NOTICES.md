# Third-party notices

## Jev Ultrafast

The browser-action core under `src/jev/` is a TypeScript port of Jev Ultrafast.

- Upstream: https://github.com/browser-use/jev-ultrafast
- Commit: 1231850a0bf1a0c0341fe408ef1668dbbfdfac46
- License: MIT
- Copyright (c) 2026 Browser Use

Ported files:

- `jev_ultrafast/agent.py` → `src/jev/agent.ts`
- `jev_ultrafast/browser.py` → `src/jev/browser.ts`
- `jev_ultrafast/model.py` → `src/jev/model.ts`
- `jev_ultrafast/questions.py` → `src/jev/questions.ts`
- `jev_ultrafast/snapshot.js` → `src/jev/snapshot.js` (one leading comment; the body is the upstream file, byte for byte)

`src/jev/cdp.ts`, `src/jev/decide.ts`, and `src/jev/providers/` are new code written for this port. They are not copies of the upstream sources. Deviations are listed in `src/jev/UPSTREAM.md`.

```
MIT License

Copyright (c) 2026 Browser Use

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
