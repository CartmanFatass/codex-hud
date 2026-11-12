# 03: Chinese sentences colour their keywords instead of showing brackets

**What to build:** in a Chinese panel, the model's keyword marks colour the word like in English; brackets never show.
Found in the owner's live test: the model marked keywords with `「…」`, which showed literally
(`「bar-fields.ts」以「835行」`). The prompt asks for `«…»` in every language, and `「…」` used as marks are read as
plain keyword marks.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] `「x」` marks in a model sentence paint like `«x»` and the brackets are not shown
- [x] Ordinary quoted Chinese text that is not a mark pattern stays as written (no false colouring of a whole sentence)
- [x] The sentence prompt states the `«…»` grammar for Chinese output too
- [x] EN and ZH tests for job, native and decision-title sentences
